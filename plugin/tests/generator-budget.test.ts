import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply } from '../src/generator.ts'
import { loadState, saveState } from '../src/state-file.ts'

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-budget-'))
  const tools: Array<{ name: string; execute(args: unknown): Promise<unknown> }> = []
  apply({ tools: { register(tool: typeof tools[number]) { tools.push(tool) } } } as never, { workspace })
  const submit = tools.find(tool => tool.name === 'submit_spec')!
  const path = join(workspace, '.canness', 'state.json')
  const spec = (name = 'ArgMax', target = 120) => ({
    operator_name: name, operator_type: 'SortSelect',
    input_specs: [{ name: 'x', shape: ['2048', '2048'], dtype: 'float16' }],
    output_specs: [{ name: 'index', shape: ['2048'], dtype: 'float32' }],
    target_platform: { chip: 'Ascend910B' },
    performance_target: { metric: 'kernel_time', target_us: target },
  })
  return { submit, path, spec }
}

test('same operator resubmission carries the iteration budget', async () => {
  const { submit, path, spec } = setup()
  await submit.execute({ spec: spec() })
  saveState(path, { ...loadState(path), validIterations: 7, compileRetries: 2, bestKernelTimeUs: 350 })
  expect(await submit.execute({ spec: spec() })).toMatchObject({ carriedOver: true })
  expect(loadState(path)).toMatchObject({ validIterations: 7, compileRetries: 2, bestKernelTimeUs: 350 })
})

test('reset deliberately starts a fresh budget', async () => {
  const { submit, path, spec } = setup()
  await submit.execute({ spec: spec() })
  saveState(path, { ...loadState(path), validIterations: 7 })
  expect(await submit.execute({ spec: spec(), reset: true })).toMatchObject({ carriedOver: false })
  expect(loadState(path).validIterations).toBe(0)
})

test('a different operator starts a fresh budget', async () => {
  const { submit, path, spec } = setup()
  await submit.execute({ spec: spec() })
  saveState(path, { ...loadState(path), validIterations: 7 })
  expect(await submit.execute({ spec: spec('Gelu') })).toMatchObject({ carriedOver: false })
  expect(loadState(path).validIterations).toBe(0)
})

test('relaxing the target is recorded in the result and state', async () => {
  const { submit, path, spec } = setup()
  await submit.execute({ spec: spec() })
  const result = await submit.execute({ spec: spec('ArgMax', 400) })
  expect(result).toMatchObject({ carriedOver: true, relaxedTargetFromUs: 120 })
  expect(loadState(path).targetRelaxedUs).toBe(120)
})
