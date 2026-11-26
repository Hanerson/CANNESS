import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { buildTestPackage, repairPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { exportSubmission } from '../src/submission.ts'
import { sha256 } from '../src/provenance.ts'

const KERNEL = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in0, GM_ADDR out0, GM_ADDR tiling) {}'

function exportFixture(target_platform = { chip: 'Ascend910B2' } as Record<string, string>) {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const generation = 'gen-deadbeef'
  const spec = parseSpec({
    operator_name: 'Exp', operator_type: 'elementwise',
    input_specs: [{ name: 'input', shape: ['16'], dtype: 'float32' }],
    output_specs: [{ name: 'output', shape: ['16'], dtype: 'float32' }],
    target_platform, performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, generation, { kernel: KERNEL, host: '', api: '', plugin: '' })
  buildTestPackage(workspace, generation, spec)
  return { workspace, generation, spec }
}

test('portable export binds the selected architecture and hashes an explicit build override', () => {
  const { workspace, generation, spec } = exportFixture({ chip: 'Ascend910B2', mode: 'portable' })
  const script = '#!/bin/bash\r\necho custom\r\n'
  const original = exportSubmission(workspace, generation, spec, 'exp', { targetSoc: 'Ascend910_9362' })
  const custom = exportSubmission(workspace, generation, spec, 'exp', { targetSoc: 'ascend950', buildScript: script })
  const read = (path: string) => JSON.parse(readFileSync(join(path, 'provenance.json'), 'utf8'))
  const build = readFileSync(join(custom.sourceDir, 'build.sh'), 'utf8')
  expect(build).toBe('#!/bin/bash\necho custom\n')
  expect(read(custom.sourceDir)).toMatchObject({
    targetPlatform: { mode: 'portable', selected: { archFamily: 'ascend950', npuArch: 'dav-3510' } },
    build: { source: 'override', scriptSha256: sha256(build) }, files: { 'build.sh': sha256(build) },
  })
  expect(read(original.sourceDir)).toMatchObject({
    targetPlatform: { selected: { archFamily: 'ascend910_93', npuArch: 'dav-2201' } },
    build: { source: 'template', dialect: 'compiler-probe', templateSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  })
})

test('rejects an incompatible export target for a pinned generation', () => {
  const { workspace, generation, spec } = exportFixture()
  expect(() => exportSubmission(workspace, generation, spec, 'exp', { targetSoc: 'ascend950' }))
    .toThrow(/dav-3510.*dav-2201/)
})

const bash = process.platform === 'win32'
  ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim() ?? '', '../../..', 'bin/bash.exe')
  : 'bash'
const bashAvailable = spawnSync(bash, ['-c', '[[ ${BASH_VERSINFO[0]} -ge 4 ]]']).status === 0

function runBuild(soc: string, compilerMode: string, mode: 'pinned' | 'portable' = 'pinned') {
  const { workspace, generation, spec } = exportFixture({ chip: 'Ascend910B2', mode })
  const { sourceDir } = exportSubmission(workspace, generation, spec, 'exp')
  writeFileSync(join(sourceDir, 'fake-bisheng'), [
    '#!/usr/bin/env bash',
    'printf "%s\\n" "$*" >> compiler.log',
    'if [[ "$*" == *-xasc* && "$FAKE_COMPILER_MODE" == legacy ]]; then exit 87; fi',
    'if [[ "$*" == *csrc/op_kernel/kernel.cpp* && "$FAKE_COMPILER_MODE" == broken-source ]]; then',
    '  echo "kernel has a real compile error" >&2; exit 42',
    'fi',
    'exit 0',
  ].join('\n'), { mode: 0o755 })
  const result = spawnSync(bash, ['build.sh', `--soc=${soc}`], {
    cwd: sourceDir, encoding: 'utf8',
    env: { ...process.env, CANNESS_BISHENG: './fake-bisheng', PYTHON: 'true', FAKE_COMPILER_MODE: compilerMode },
  })
  const logPath = join(sourceDir, 'compiler.log')
  const calls = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n') : []
  return { ...result, calls, sourceDir }
}

test.skipIf(!bashAvailable).each(['ascend910b', 'ascend910_93'])('builds %s using the modern microarchitecture flags', soc => {
  const { status, stdout, stderr, calls, sourceDir } = runBuild(soc, 'modern')
  expect(status, stderr).toBe(0)
  expect(stdout).toMatch(/dialect=modern.*dav-2201/)
  const kernel = calls.find(call => call.includes('csrc/op_kernel/kernel.cpp'))
  expect(kernel).toContain('-xasc -std=c++17 -fPIC --npu-arch=dav-2201')
  expect(kernel).not.toContain('--cce-soc-version=')
  // The archive carries what the target build actually chose.
  const env = readFileSync(join(sourceDir, 'dist', 'build-env.txt'), 'utf8')
  expect(env).toContain('npu_arch=dav-2201')
  expect(env).toMatch(/^dialect=modern$/m)
  expect(env).toContain('-xasc -std=c++17 -fPIC --npu-arch=dav-2201')
})

test.skipIf(!bashAvailable)('probes compiler support before using legacy 910B flags', () => {
  const { status, stdout, stderr, calls } = runBuild('ascend910b', 'legacy')
  expect(status, stderr).toBe(0)
  expect(stdout).toMatch(/dialect=legacy.*Ascend910B2/)
  expect(calls.filter(call => call.includes('csrc/op_kernel/kernel.cpp'))).toEqual([
    expect.stringContaining('-x cce -std=c++17 -fPIC --cce-soc-version=Ascend910B2 --cce-soc-core-type=VecCore'),
  ])
})

test.skipIf(!bashAvailable)('does not retry a kernel source error with a different compiler dialect', () => {
  const { status, stderr, calls } = runBuild('ascend910b', 'broken-source')
  expect(status).toBe(42)
  expect(stderr).toContain('kernel has a real compile error')
  expect(calls.filter(call => call.includes('csrc/op_kernel/kernel.cpp'))).toHaveLength(1)
  expect(calls.join('\n')).not.toContain('--cce-soc-version=')
})

test.skipIf(!bashAvailable)('does not invoke the compiler when a pinned export receives an incompatible SoC', () => {
  const { status, stderr, calls } = runBuild('Ascend950PR_9579', 'modern')
  expect(status).toBe(2)
  expect(stderr).toMatch(/Ascend950PR_9579 uses dav-3510.*targets dav-2201/)
  expect(calls).toEqual([])
})

test.skipIf(!bashAvailable)('accepts the 950 part name on a portable export', () => {
  const { status, stderr, calls } = runBuild('Ascend950PR_9579', 'modern', 'portable')
  expect(status, stderr).toBe(0)
  expect(calls.find(call => call.includes('csrc/op_kernel/kernel.cpp'))).toContain('--npu-arch=dav-3510')
})

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

const kernelRepairPaths = ['op_kernel/kernel.cpp', './op_kernel/kernel.cpp', 'op_kernel\\kernel.cpp']
test.each(kernelRepairPaths)('export keeps provenance layers in sync after repair rewrites %s', (path) => {
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
  repairPackage(workspace, 'gen-deadbeef', { write: [{ path, content: repaired }] })
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


