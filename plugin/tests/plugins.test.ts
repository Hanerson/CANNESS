import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import * as knowledge from '../src/knowledge.ts'
import * as generator from '../src/generator.ts'
import * as evalPlugin from '../src/eval.ts'
import * as loop from '../src/loop.ts'

function fakeCtx() {
  const tools: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const listeners: { event: string; fn: Function }[] = []
  return {
    tools: { register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) { tools.push(tool) } },
    on(event: string, fn: Function) { listeners.push({ event, fn }) },
    toolsRegistered: tools,
    listeners,
  }
}

test('registers the five tools and two loop listeners', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const kb = fakeCtx()
  knowledge.apply(kb as never, { kbRoot: new URL('../knowledge_base/', import.meta.url).pathname })
  const gen = fakeCtx()
  generator.apply(gen as never, { workspace })
  const ev = fakeCtx()
  evalPlugin.apply(ev as never, {
    workspace, host: '', port: 22, username: '', privateKeyPath: '',
    inbox: '/tmp/canness/inbox', outbox: '/tmp/canness/outbox', timeoutSec: 1800, pollIntervalMs: 2000,
    maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  const lp = fakeCtx()
  loop.apply(lp as never, {
    workspace, maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  expect(kb.toolsRegistered.map(tool => tool.name)).toEqual(['kb_search'])
  expect(gen.toolsRegistered.map(tool => tool.name)).toEqual(['submit_spec', 'write_operator', 'build_test_package'])
  expect(ev.toolsRegistered.map(tool => tool.name)).toEqual(['run_evaluation'])
  expect(lp.listeners.map(item => item.event)).toEqual(['agent/pre-step', 'agent/turn-stopping'])
})

test('submit_spec rejects the first missing field and writes no state', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const gen = fakeCtx()
  generator.apply(gen as never, { workspace })
  const submit = gen.toolsRegistered.find(tool => tool.name === 'submit_spec')!
  await expect(submit.execute({ spec: { operator_name: 'Add' } })).rejects.toThrow('missing performance_target.metric')
  expect(existsSync(join(workspace, '.canness', 'state.json'))).toBe(false)
})

test('run_evaluation with an empty host does not throw and reports ssh host is empty', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const ev = fakeCtx()
  evalPlugin.apply(ev as never, {
    workspace, host: '', port: 22, username: '', privateKeyPath: '',
    inbox: '/in', outbox: '/out', timeoutSec: 1, pollIntervalMs: 1,
    maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  })
  const tool = ev.toolsRegistered[0]!
  const value = await tool.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh host is empty' })
})
