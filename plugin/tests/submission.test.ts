import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildTestPackage, repairPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { exportSubmission } from '../src/submission.ts'
import { sha256 } from '../src/provenance.ts'

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

test('export accepts a package repaired after build_test_package (CAN-103)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const spec = parseSpec({
    operator_name: 'Add', operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }],
    output_specs: [{ name: 'y', shape: ['16'], dtype: 'float32' }],
    target_platform: { chip: 'Ascend910B2' }, performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, 'gen-deadbeef', { kernel: KERNEL, host: '', api: '', plugin: '' })
  buildTestPackage(workspace, 'gen-deadbeef', spec)
  repairPackage(workspace, 'gen-deadbeef', { drop: ['.contract-selfcheck'] })
  const artifact = exportSubmission(workspace, 'gen-deadbeef', spec)
  expect(existsSync(artifact.archivePath)).toBe(true)
})

test('export keeps provenance layers in sync after repair rewrites a layer (CAN-103 review)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const spec = parseSpec({
    operator_name: 'Add', operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }],
    output_specs: [{ name: 'y', shape: ['16'], dtype: 'float32' }],
    target_platform: { chip: 'Ascend910B2' }, performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, 'gen-deadbeef', { kernel: KERNEL, host: '', api: '', plugin: '' })
  buildTestPackage(workspace, 'gen-deadbeef', spec)
  const repaired = `${KERNEL}\n// repaired after packaging`
  repairPackage(workspace, 'gen-deadbeef', { write: [{ path: 'op_kernel/kernel.cpp', content: repaired }] })
  const artifact = exportSubmission(workspace, 'gen-deadbeef', spec)
  const provenance = JSON.parse(readFileSync(join(artifact.sourceDir, 'provenance.json'), 'utf8'))
  expect(provenance.files['csrc/op_kernel/kernel.cpp']).toBe(sha256(repaired))
  expect(provenance.layers['op_kernel/kernel.cpp'].sha256).toBe(sha256(repaired))
  expect(provenance.layers['op_kernel/kernel.cpp'].modifiedByRepair).toBe(true)
})

test('export includes custom wrapper and public signature in hashed unverified provenance', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const spec = parseSpec({ operator_name: 'scan', operator_type: 'scan',
    input_specs: [{name:'input',shape:['16'],dtype:'float32'}],
    output_specs: [{name:'output',shape:['16'],dtype:'float32'}],
    attrs: {dim:0, inner:1}, interface:{attrs:['dim']},
    target_platform:{chip:'Ascend910B2'},performance_target:{metric:'kernel_time',target_us:50}})
  writeOperator(workspace, 'gen-deadbeef', {kernel:KERNEL,host:'',api:'',plugin:''})
  buildTestPackage(workspace,'gen-deadbeef',spec)
  const generated = exportSubmission(workspace,'gen-deadbeef',spec)
  expect(generated.signature).toBe('scan(input, dim)')
  const wrapper = 'def scan(input, dim):\n    return input\n'
  const artifact = exportSubmission(workspace,'gen-deadbeef',spec,'scan',{wrapper,signature:'scan(input, dim)'})
  expect(readFileSync(join(artifact.sourceDir,'cann_bench/__init__.py'),'utf8')).toBe(wrapper)
  const provenance = JSON.parse(readFileSync(join(artifact.sourceDir,'provenance.json'),'utf8'))
  expect(provenance.validation.status).toBe('unverified')
  expect(provenance.files['cann_bench/__init__.py']).toBe(sha256(wrapper))
  expect(provenance.publicSignatureHash).toBe(sha256('scan(input, dim)'))
})

test('custom wrapper exports shape-changing mixed output dtype variants and rejects missing signature', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const spec = parseSpec({operator_name:'reduce',operator_type:'reduce',
    input_specs:[{name:'input',shape:['16'],dtype:'float32'}],
    output_specs:[{name:'output',shape:['1'],dtype:'float32'},{name:'index',shape:['1'],dtype:'int64'}],
    interface:{dtypes:['float16','float32']},target_platform:{chip:'Ascend910B2'},
    performance_target:{metric:'kernel_time',target_us:50}})
  writeOperator(workspace,'gen-deadbeef',{kernel:KERNEL,host:'',api:'',plugin:''})
  buildTestPackage(workspace,'gen-deadbeef',spec)
  expect(() => exportSubmission(workspace,'gen-deadbeef',spec,'reduce',{wrapper:'pass'})).toThrow(/signature/)
  const artifact = exportSubmission(workspace,'gen-deadbeef',spec,'reduce',{
    wrapper:'def reduce(input):\n    return input\n',signature:'reduce(input)'})
  expect(readFileSync(join(artifact.sourceDir,'csrc/float16/canness_tiling.h'),'utf8')).toContain('using DTYPE_Y = half;')
  expect(JSON.parse(readFileSync(join(artifact.sourceDir,'provenance.json'),'utf8')).signature).toBe('reduce(input)')
})
