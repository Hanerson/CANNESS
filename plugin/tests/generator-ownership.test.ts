import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply } from '../src/generator.ts'
import { loadState } from '../src/state-file.ts'
const spec = { operator_name: 'Exp', operator_type: 'Elementwise', input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }], output_specs: [{ name: 'y', shape: ['16'], dtype: 'float32' }], target_platform: { chip: 'Ascend910B' }, performance_target: { metric: 'kernel_time', target_us: 20 } }
const session = (id: string) => ({ agent: { session: { id } } })
test('workspace ownership is claimed at submission and a different session cannot reset or mutate it', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-owner-'))
  const tools: any[] = []
  apply({ tools: { register(tool: any) { tools.push(tool) } } } as never, { workspace })
  const call = (name: string, args: any, context: any) => tools.find(tool => tool.name === name).execute(args, context)
  const stateFile = join(workspace, '.canness/state.json')
  await call('submit_spec', { spec }, session('first'))
  expect(loadState(stateFile).ownerSessionId).toBe('first')
  const generation = loadState(stateFile).generationId
  const window = loadState(stateFile).budgetWindowStartedAt
  expect(window).toEqual(expect.any(String))
  for (const [name, args] of [ ['submit_spec', { spec, reset: true }], ['write_operator', { host: 'change' }], ['write_package_file', { path: 'golden.h', content: 'change' }], ['build_test_package', {}], ['export_submission', {}] ] as const) {
    await expect(call(name, args, session('second'))).rejects.toThrow(/ownership.*first.*second/)
    expect(loadState(stateFile)).toMatchObject({ generationId: generation, ownerSessionId: 'first', budgetWindowStartedAt: window, lastBlocked: { blockedBy: 'ownership', session: 'second' } })
  }
  await expect(call('submit_spec', { spec }, undefined)).rejects.toThrow(/ownership/)
  expect(JSON.parse(readFileSync(stateFile, 'utf8')).lastBlocked.session).toBeNull()
  await call('submit_spec', { spec }, session('first'))
  expect(loadState(stateFile).budgetWindowStartedAt).toBe(window)
  await call('submit_spec', { spec, reset: true }, session('first'))
  expect(loadState(stateFile).ownerSessionId).toBe('first')
})
