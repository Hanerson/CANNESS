import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply } from '../src/generator.ts'
import { sha256 } from '../src/provenance.ts'

const spec = { operator_name: 'Exp', operator_type: 'Elementwise', input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }], output_specs: [{ name: 'y', shape: ['16'], dtype: 'float32' }], target_platform: { chip: 'Ascend910B' }, performance_target: { metric: 'kernel_time', target_us: 20 } }
const kernel = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {}'
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-artifacts-'))
  const tools: any[] = []
  let approval = ''
  apply({
    tools: { register(tool: any) { tools.push(tool) } },
    get(name: string) { return name.startsWith('canness:target-approval:') ? () => ({ approval, endpoint: 'npu:22' }) : undefined },
  } as never, { workspace })
  return { workspace, approve: (value: string) => { approval = value }, call: (name: string, args = {}) => tools.find(t => t.name === name).execute(args) }
}
test('reset preserves compatible source layers, golden and provenance and can build immediately', async () => {
  const { workspace, call } = setup()
  const first = await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: '// host', api: '// api', plugin: '# plugin', provenance: { host: { kind: 'copied_from', source: 'reference' } } })
  await call('write_package_file', { path: 'golden.h', content: '// custom golden' })
  const next = await call('submit_spec', { spec, reset: true })
  expect(next).toMatchObject({ carriedOver: false, carriedLayers: true, needsLayers: false })
  for (const file of ['op_kernel/kernel.cpp', 'op_host/host.cpp', 'op_api/api.cpp', 'op_plugin/plugin.py', 'golden.h', 'layer-origins.json']) {
    expect(readFileSync(join(workspace, 'operators', next.generationId, file))).toEqual(readFileSync(join(workspace, 'operators', first.generationId, file)))
  }
  await expect(call('build_test_package')).resolves.toHaveProperty('packageDir')
})
test('changed contracts require sources and report the recovery tool', async () => {
  const { call } = setup()
  await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  expect(await call('submit_spec', { spec: { ...spec, attrs: { axis: 1 } }, reset: true })).toMatchObject({ carriedLayers: false, needsLayers: true })
  await expect(call('build_test_package')).rejects.toThrow(/build_test_package.*write_operator/)
})

test('a kernel-only generation can be packaged and exported automatically', async () => {
  const { call } = setup()
  const first = await call('submit_spec', { spec })
  expect(first).toMatchObject({ needsLayers: true })
  await call('write_operator', { kernel })
  const next = await call('submit_spec', { spec, reset: true })
  expect(next).toMatchObject({ carriedLayers: true, needsLayers: false })
  const { packageDir } = await call('build_test_package')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'))
  expect(manifest.layers).toEqual(['op_kernel/kernel.cpp'])
  expect(manifest.compiledLayers).toEqual(['op_kernel/kernel.cpp'])
  expect(manifest.documentedOnlyLayers).toEqual([])
  const { sourceDir } = await call('export_submission', { callable: 'exp' })
  const exported = JSON.parse(readFileSync(join(sourceDir, 'provenance.json'), 'utf8'))
  expect(exported.documentedOnlyLayers).toEqual([])
  expect(exported.layers['op_kernel/kernel.cpp'].sha256).toBe(sha256(kernel))
})

test('packaging preserves supplied optional layers and their provenance through a compatible generation', async () => {
  const { call } = setup()
  await call('submit_spec', { spec })
  await call('write_operator', { host: 'optional host' })
  await expect(call('build_test_package')).rejects.toThrow(/is missing op_kernel\/kernel\.cpp; call write_operator/)
  await call('write_operator', { kernel, host: 'optional host', provenance: { host: { kind: 'generated' } } })
  await expect(call('submit_spec', { spec })).resolves.toMatchObject({ carriedLayers: true, needsLayers: false })
  const { packageDir } = await call('build_test_package')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'))
  expect(manifest.layers).toEqual(['op_kernel/kernel.cpp', 'op_host/host.cpp'])
  expect(manifest.documentedOnlyLayers).toEqual(['op_host/host.cpp'])
  expect(manifest.provenance['op_host/host.cpp']).toMatchObject({
    declared: { kind: 'generated' }, sha256: sha256('optional host'),
  })
  expect(readFileSync(join(packageDir, 'op_host/host.cpp'), 'utf8')).toBe('optional host')
  const { sourceDir } = await call('export_submission', { callable: 'exp' })
  const exported = JSON.parse(readFileSync(join(sourceDir, 'provenance.json'), 'utf8'))
  expect(exported.documentedOnlyLayers).toEqual(['op_host/host.cpp'])
  expect(exported.layers['op_host/host.cpp']).toEqual(manifest.provenance['op_host/host.cpp'])
})
test('partial updates preserve untouched files and origins and validate supplied kernels', async () => {
  const { workspace, call } = setup()
  const { generationId } = await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin', provenance: { host: { kind: 'copied_from', source: 'reference' }, kernel: { kind: 'adapted_from', source: 'old' } } })
  const root = join(workspace, 'operators', generationId)
  const before = statSync(join(root, 'op_host/host.cpp')).mtimeMs
  for (let i = 0; i < 20; i++) await call('write_operator', { kernel: kernel + `// ${i}` })
  expect(statSync(join(root, 'op_host/host.cpp')).mtimeMs).toBe(before)
  expect(JSON.parse(readFileSync(join(root, 'layer-origins.json'), 'utf8'))).toEqual({
    host: { kind: 'copied_from', source: 'reference', verification: { status: 'unchecked', reason: expect.any(String) } },
  })
  await expect(call('write_operator', { host: 'updated' })).resolves.toHaveProperty('operatorDir')
  await expect(call('write_operator', { kernel: 'void invalid() {}' })).rejects.toThrow(/write_operator.*canness_kernel/)
  await expect(call('write_operator')).rejects.toThrow(/write_operator.*kernel/)
})

test('write_operator rejects a declared source digest mismatch before replacing any layer', async () => {
  const { workspace, call } = setup()
  await call('submit_spec', { spec })
  const { operatorDir } = await call('write_operator', { kernel, host: 'original' })
  writeFileSync(join(workspace, 'reference.cpp'), 'reference bytes\n')
  await expect(call('write_operator', {
    kernel: `${kernel}\n// rewritten`, host: 'new',
    provenance: { host: { kind: 'adapted_from', source: 'example', sourceFile: 'reference.cpp', sha256: '0'.repeat(64) } },
  })).rejects.toThrow(/provenance\.host.*source SHA-256.*does not match/)
  expect(readFileSync(join(operatorDir, 'op_kernel/kernel.cpp'), 'utf8')).toBe(kernel)
  expect(readFileSync(join(operatorDir, 'op_host/host.cpp'), 'utf8')).toBe('original')
})

test('a verified source digest remains separate from the layer hash after repair', async () => {
  const { workspace, call } = setup()
  await call('submit_spec', { spec })
  const reference = 'reference bytes\r\n'
  writeFileSync(join(workspace, 'reference.cpp'), reference)
  const declaration = { kind: 'adapted_from', source: 'example', sourceFile: 'reference.cpp', sha256: sha256(reference) }
  await call('write_operator', { kernel, host: 'adapted', api: 'api', plugin: 'plugin', provenance: { host: declaration } })
  const { packageDir } = await call('build_test_package')
  await call('repair_package', { write: [{ path: 'op_host/host.cpp', content: 'repaired' }] })
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8'))
  expect(manifest.provenance['op_host/host.cpp']).toMatchObject({
    sha256: sha256('repaired'), modifiedByRepair: true,
    declared: { ...declaration, verification: { status: 'verified' } },
  })
})

test('absent source files and historical source labels remain unchecked', async () => {
  const { workspace, call } = setup()
  await call('submit_spec', { spec })
  writeFileSync(join(workspace, 'narrative.cpp'), 'not explicitly offered for verification')
  const sha256 = '0'.repeat(64)
  const { operatorDir } = await call('write_operator', {
    kernel, host: 'host', provenance: {
      kernel: { kind: 'copied_from', source: 'narrative.cpp', sha256 },
      host: { kind: 'adapted_from', source: 'example', sourceFile: 'absent.cpp', sha256, verification: { status: 'verified' } },
    },
  })
  const saved = JSON.parse(readFileSync(join(operatorDir, 'layer-origins.json'), 'utf8'))
  expect(saved.kernel).toMatchObject({ sha256, verification: { status: 'unchecked', reason: expect.stringMatching(/sourceFile/) } })
  expect(saved.host).toMatchObject({ sha256, verification: { status: 'unchecked', reason: expect.stringMatching(/not found/) } })
})

test('write_operator rejects paths outside the workspace', async () => {
  const { call } = setup()
  await call('submit_spec', { spec })
  await expect(call('write_operator', {
    kernel, provenance: { kernel: { kind: 'copied_from', source: 'example', sourceFile: '../reference.cpp', sha256: '0'.repeat(64) } },
  })).rejects.toThrow(/provenance\.kernel\.sourceFile.*workspace-relative/)
})

test('write_operator marks non-files and oversized source files unchecked', async () => {
  const { workspace, call } = setup()
  mkdirSync(join(workspace, 'directory'))
  const largeFile = join(workspace, 'oversized')
  writeFileSync(largeFile, '')
  truncateSync(largeFile, 8 * 1024 * 1024 + 1)
  await call('submit_spec', { spec })
  const sha256 = '0'.repeat(64)
  const { operatorDir } = await call('write_operator', {
    kernel, host: 'host', provenance: {
      kernel: { kind: 'copied_from', source: 'directory', sourceFile: 'directory', sha256 },
      host: { kind: 'copied_from', source: 'oversized', sourceFile: 'oversized', sha256 },
    },
  })
  const saved = JSON.parse(readFileSync(join(operatorDir, 'layer-origins.json'), 'utf8'))
  expect(saved.kernel.verification).toMatchObject({ status: 'unchecked', reason: expect.stringMatching(/regular file/) })
  expect(saved.host.verification).toMatchObject({ status: 'unchecked', reason: expect.stringMatching(/verification limit/) })
})

test('write_operator checks the real workspace boundary for an explicit source file', async ({ skip }) => {
  const { workspace, call } = setup()
  const outside = mkdtempSync(join(tmpdir(), 'canness-outside-'))
  writeFileSync(join(outside, 'reference.cpp'), 'outside the operator workspace')
  try {
    symlinkSync(outside, join(workspace, 'link'), 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') skip()
    throw error
  }
  await call('submit_spec', { spec })
  await expect(call('write_operator', {
    kernel, provenance: { kernel: { kind: 'copied_from', source: 'example', sourceFile: 'link/reference.cpp', sha256: '0'.repeat(64) } },
  })).rejects.toThrow(/provenance\.kernel.*outside the workspace/)
})

test.each([
  { input_specs: [{ name: 'x', shape: ['32'], dtype: 'float32' }] },
  { input_specs: [{ name: 'x', shape: ['16'], dtype: 'float16' }] },
  { operator_name: 'Other' },
])('does not reuse artifacts for incompatible contract %j', async change => {
  const { call } = setup()
  await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  expect(await call('submit_spec', { spec: { ...spec, ...change } })).toMatchObject({ carriedLayers: false, needsLayers: true })
})
test('timing target changes preserve compatible sources independently of budget carryover', async () => {
  const { call } = setup()
  expect(await call('submit_spec', { spec })).toMatchObject({ carriedLayers: false, needsLayers: true })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  expect(await call('submit_spec', { spec: { ...spec, performance_target: { metric: 'kernel_time', target_us: 40 } } })).toMatchObject({ carriedLayers: true, needsLayers: false, carriedOver: true })
})

test('submit_spec requires a recognizable declaration and a mismatched probe needs confirmation', async () => {
  const { workspace, call, approve } = setup()
  const target = { ...spec, target_platform: { chip: 'A3', arch_family: 'ascend910_93', soc_version: 'Ascend910_9362' } }
  await expect(call('submit_spec', { spec: { ...spec, target_platform: { chip: 'unknown' } } }))
    .rejects.toThrow(/ascend910b.*ascend910_93.*ascend950/)
  const pending = await call('submit_spec', { spec: target, detected_soc: 'Ascend910B2', confirm_target: true })
  expect(pending).toMatchObject({
    requiresConfirmation: true,
    declared: { archFamily: 'ascend910_93', npuArch: 'dav-2201' },
    detected: { archFamily: 'ascend910b', npuArch: 'dav-2201' },
    approvalId: expect.stringMatching(/^canness-[a-f0-9]{24}$/u),
  })
  const stateFile = join(workspace, '.canness', 'state.json')
  expect(existsSync(stateFile)).toBe(false)
  await expect(call('submit_spec', { spec: target })).resolves.toMatchObject({ approvalId: pending.approvalId })
  expect(existsSync(stateFile)).toBe(false)
  approve(pending.approvalId)
  await expect(call('submit_spec', { spec: target, detected_soc: 'Ascend910B3', confirm_target: true })).resolves.toMatchObject({ requiresConfirmation: true })
  await expect(call('submit_spec', { spec: target, detected_soc: 'Ascend910B2', confirm_target: true })).resolves.toHaveProperty('generationId')
  const { spec: stored } = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(stored.target_platform.confirmation).toEqual({ confirmed: true, detectedSoc: 'Ascend910B2', approvalId: pending.approvalId })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  const { packageDir } = await call('build_test_package')
  expect(JSON.parse(readFileSync(join(packageDir, 'config.json'), 'utf8'))).toMatchObject({
    socVersion: 'Ascend910_9362', targetPlatform: stored.target_platform,
  })
})

test('repair_package directs evaluation build changes to the explicit export override', async () => {
  const { call } = setup()
  await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  await call('build_test_package')
  await expect(call('repair_package', { write: [{ path: './build.sh', content: '#!/bin/bash\n' }] }))
    .resolves.toHaveProperty('note', expect.stringMatching(/evaluation.*export_submission.*build_script/))
})

test('an unchanged portable target carries its confirmation into the next generation', async () => {
  const { call, approve } = setup()
  const portable = { ...spec, target_platform: { chip: 'Ascend910B2', mode: 'portable' } }
  const pending = await call('submit_spec', { spec: portable })
  expect(pending).toMatchObject({ requiresConfirmation: true })
  approve(pending.approvalId)
  await expect(call('submit_spec', { spec: portable, confirm_target: true })).resolves.toHaveProperty('generationId')
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  await expect(call('submit_spec', { spec: portable })).resolves.toMatchObject({ carriedLayers: true })
  await call('build_test_package')
  await expect(call('export_submission', { target_soc: 'ascend950', build_script: '#!/bin/bash\necho custom\n' }))
    .resolves.toMatchObject({ targetPlatform: { selected: { npuArch: 'dav-3510' } }, build: { source: 'override' } })
})
