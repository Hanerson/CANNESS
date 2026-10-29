import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { newGenerationId } from '../src/ids.ts'
import { buildTestPackage, LAYER_FILES, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { emptyState } from '../src/policy.ts'
import { loadState, saveState } from '../src/state-file.ts'

test('generation ids keep the gen- prefix and 8 hex chars', () => {
  expect(newGenerationId('01234567-89ab-cdef-0123-456789abcdef')).toBe('gen-01234567')
})

test('writeOperator and buildTestPackage lay down the four layers and manifest', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-ws-'))
  const spec = parseSpec({
    operator_name: 'Add',
    operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['N'], dtype: 'float16' }],
    output_specs: [{ name: 'y', shape: ['N'], dtype: 'float16' }],
    target_platform: { chip: 'Ascend910B' },
    performance_target: { metric: 'kernel_time', target_us: 150 },
  })
  const opDir = writeOperator(workspace, 'gen-01234567', {
    kernel: 'K', host: 'H', api: 'A', plugin: 'P',
  })
  expect(readFileSync(join(opDir, LAYER_FILES.kernel), 'utf8')).toBe('K')
  const pkg = buildTestPackage(workspace, 'gen-01234567', spec)
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({
    generationId: 'gen-01234567',
    operatorName: 'Add',
    performanceTargetUs: 150,
  })
  expect(readFileSync(join(pkg, 'op_plugin/plugin.py'), 'utf8')).toBe('P')
})

test('state file round-trips and a missing file is empty', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-st-'))
  const path = join(workspace, '.canness', 'state.json')
  expect(loadState(path).generationId).toBeNull()
  const state = { ...emptyState(), generationId: 'gen-01234567' }
  saveState(path, state)
  expect(loadState(path).generationId).toBe('gen-01234567')
})
