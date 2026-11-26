import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply } from '../src/generator.ts'

const spec = { operator_name: 'Exp', operator_type: 'Elementwise', input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }], output_specs: [{ name: 'y', shape: ['16'], dtype: 'float32' }], target_platform: { chip: 'Ascend910B' }, performance_target: { metric: 'kernel_time', target_us: 20 } }
const kernel = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {}'
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-artifacts-'))
  const tools: any[] = []
  apply({ tools: { register(tool: any) { tools.push(tool) } } } as never, { workspace })
  return { workspace, call: (name: string, args = {}) => tools.find(t => t.name === name).execute(args) }
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
test('partial updates preserve untouched files and origins and validate supplied kernels', async () => {
  const { workspace, call } = setup()
  const { generationId } = await call('submit_spec', { spec })
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin', provenance: { host: { kind: 'copied_from', source: 'reference' }, kernel: { kind: 'adapted_from', source: 'old' } } })
  const root = join(workspace, 'operators', generationId)
  const before = statSync(join(root, 'op_host/host.cpp')).mtimeMs
  for (let i = 0; i < 20; i++) await call('write_operator', { kernel: kernel + `// ${i}` })
  expect(statSync(join(root, 'op_host/host.cpp')).mtimeMs).toBe(before)
  expect(JSON.parse(readFileSync(join(root, 'layer-origins.json'), 'utf8'))).toEqual({ host: { kind: 'copied_from', source: 'reference' } })
  await expect(call('write_operator', { host: 'updated' })).resolves.toHaveProperty('operatorDir')
  await expect(call('write_operator', { kernel: 'void invalid() {}' })).rejects.toThrow(/write_operator.*canness_kernel/)
  await expect(call('write_operator')).rejects.toThrow(/write_operator.*kernel/)
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
  const { workspace, call } = setup()
  const target = { ...spec, target_platform: { chip: 'A3', arch_family: 'ascend910_93', soc_version: 'Ascend910_9362' } }
  await expect(call('submit_spec', { spec: { ...spec, target_platform: { chip: 'unknown' } } }))
    .rejects.toThrow(/ascend910b.*ascend910_93.*ascend950/)
  await expect(call('submit_spec', { spec: target, detected_soc: 'Ascend910B2' })).resolves.toMatchObject({
    requiresConfirmation: true,
    declared: { archFamily: 'ascend910_93', npuArch: 'dav-2201' },
    detected: { archFamily: 'ascend910b', npuArch: 'dav-2201' },
  })
  const stateFile = join(workspace, '.canness', 'state.json')
  expect(existsSync(stateFile)).toBe(false)
  await expect(call('submit_spec', { spec: target, detected_soc: 'Ascend910B2', confirm_target: true })).resolves.toHaveProperty('generationId')
  const { spec: stored } = JSON.parse(readFileSync(stateFile, 'utf8'))
  expect(stored.target_platform.confirmation).toEqual({ confirmed: true, detectedSoc: 'Ascend910B2' })
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
  const { call } = setup()
  const portable = { ...spec, target_platform: { chip: 'Ascend910B2', mode: 'portable' } }
  await expect(call('submit_spec', { spec: portable })).resolves.toMatchObject({ requiresConfirmation: true })
  await expect(call('submit_spec', { spec: portable, confirm_target: true })).resolves.toHaveProperty('generationId')
  await call('write_operator', { kernel, host: 'host', api: 'api', plugin: 'plugin' })
  await expect(call('submit_spec', { spec: portable })).resolves.toMatchObject({ carriedLayers: true })
  await call('build_test_package')
  await expect(call('export_submission', { target_soc: 'ascend950', build_script: '#!/bin/bash\necho custom\n' }))
    .resolves.toMatchObject({ targetPlatform: { selected: { npuArch: 'dav-3510' } }, build: { source: 'override' } })
})
