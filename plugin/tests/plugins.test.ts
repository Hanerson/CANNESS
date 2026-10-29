import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import * as knowledge from '../src/knowledge.ts'
import * as generator from '../src/generator.ts'
import * as evalPlugin from '../src/eval.ts'
import * as loop from '../src/loop.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote, type RemoteFiles } from '../src/remote.ts'
import type { EvalReport } from '../src/report.ts'
import { saveState } from '../src/state-file.ts'

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
  let connected = false
  evalPlugin.apply(ev as never, {
    workspace, host: '', port: 22, username: '', privateKeyPath: '',
    inbox: '/in', outbox: '/out', timeoutSec: 1, pollIntervalMs: 1,
    maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
  }, async () => { connected = true; throw new Error('connected') })
  const tool = ev.toolsRegistered[0]!
  const value = await tool.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh host is empty' })
  expect(connected).toBe(false)
})

const policy: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

function failReport(status: EvalReport['status']): EvalReport {
  return {
    generationId: 'gen-0123abcd',
    status,
    compile: { ok: false, log: 'err' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: 150 },
    analysis: null,
    summary: 'cmake',
  }
}

function readyPackage(): { workspace: string; generationId: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const generationId = 'gen-0123abcd'
  saveState(join(workspace, '.canness', 'state.json'), { ...emptyState(), generationId })
  mkdirSync(join(workspace, 'packages', generationId), { recursive: true })
  writeFileSync(join(workspace, 'packages', generationId, 'manifest.json'), '{}')
  writeFileSync(join(workspace, 'id_key'), 'KEY')
  return { workspace, generationId }
}

function trackedRemote(events: string[], upload?: () => Promise<void>): { files: RemoteFiles; remote: MemoryRemote } {
  const remote = new MemoryRemote()
  const files: RemoteFiles = {
    async uploadDir(local, dir) {
      events.push('upload')
      if (upload) await upload()
      await remote.uploadDir(local, dir)
    },
    async readFile(path) {
      events.push('read')
      return remote.readFile(path)
    },
    async removeFile(path) {
      events.push('remove')
      await remote.removeFile(path)
    },
    async close() {
      events.push('close')
    },
  }
  return { files, remote }
}

test('run_evaluation closes after a finished attempt and after an upload failure', async () => {
  const finishedEvents: string[] = []
  const finished = readyPackage()
  const finishedRemote = trackedRemote(finishedEvents)
  const resultPath = `/out/${finished.generationId}/results.json`
  finishedRemote.remote.appearOnRead(resultPath, Buffer.from(JSON.stringify({
    generationId: finished.generationId,
    status: 'compile_fail',
    compile: { ok: false, log: 'error: x' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: 150 },
    summary: 'failed compile',
  })), 1)
  const finishedCtx = fakeCtx()
  evalPlugin.apply(finishedCtx as never, {
    workspace: finished.workspace, host: 'npu', port: 22, username: 'canness',
    privateKeyPath: join(finished.workspace, 'id_key'),
    inbox: '/in', outbox: '/out', timeoutSec: 0, pollIntervalMs: 1,
    ...policy,
  }, async () => finishedRemote.files)
  const finishedValue = await finishedCtx.toolsRegistered[0]!.execute({})
  expect(finishedValue).toMatchObject({ status: 'compile_fail', summary: 'failed compile' })
  expect(finishedEvents).toEqual(['upload', 'remove', 'read', 'close'])

  const failedEvents: string[] = []
  const failed = readyPackage()
  const failedRemote = trackedRemote(failedEvents, async () => { throw new Error('upload failed') })
  const failedCtx = fakeCtx()
  evalPlugin.apply(failedCtx as never, {
    workspace: failed.workspace, host: 'npu', port: 22, username: 'canness',
    privateKeyPath: join(failed.workspace, 'id_key'),
    inbox: '/in', outbox: '/out', timeoutSec: 0, pollIntervalMs: 1,
    ...policy,
  }, async () => failedRemote.files)
  await expect(failedCtx.toolsRegistered[0]!.execute({})).rejects.toThrow('upload failed')
  expect(failedEvents).toEqual(['upload', 'close'])
})

test('run_evaluation closes after a poll timeout and does not connect when already stopped', async () => {
  const timeoutEvents: string[] = []
  const timed = readyPackage()
  const timedRemote = trackedRemote(timeoutEvents)
  const timeoutCtx = fakeCtx()
  evalPlugin.apply(timeoutCtx as never, {
    workspace: timed.workspace, host: 'npu', port: 22, username: 'canness',
    privateKeyPath: join(timed.workspace, 'id_key'),
    inbox: '/in', outbox: '/out', timeoutSec: 0, pollIntervalMs: 1,
    ...policy,
  }, async () => timedRemote.files)
  const timedOut = await timeoutCtx.toolsRegistered[0]!.execute({})
  expect(timedOut).toMatchObject({ status: 'timeout' })
  expect(timeoutEvents).toEqual(['upload', 'remove', 'read', 'close'])

  const stoppedEvents: string[] = []
  const stopped = readyPackage()
  saveState(join(stopped.workspace, '.canness', 'state.json'), {
    ...emptyState(), generationId: stopped.generationId, timeouts: 2,
  })
  const stoppedCtx = fakeCtx()
  evalPlugin.apply(stoppedCtx as never, {
    workspace: stopped.workspace, host: 'npu', port: 22, username: 'canness',
    privateKeyPath: join(stopped.workspace, 'id_key'),
    inbox: '/in', outbox: '/out', timeoutSec: 0, pollIntervalMs: 1,
    ...policy,
  }, async () => { stoppedEvents.push('connect'); throw new Error('connected') })
  const stoppedValue = await stoppedCtx.toolsRegistered[0]!.execute({})
  expect(stoppedValue).toMatchObject({ status: 'error', summary: 'stopped: timeouts' })
  expect(stoppedEvents).toEqual([])
})

test('pre-step appends a retry only when shouldSteer is true', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const lp = fakeCtx()
  loop.apply(lp as never, { workspace, ...policy })
  const pre = lp.listeners.find(item => item.event === 'agent/pre-step')!
  const enter = async () => ({ kind: 'enter' as const, messages: [] as { content: { type: string; text: string }[] }[] })

  saveState(join(workspace, '.canness', 'state.json'), {
    ...emptyState(), compileRetries: 3, lastReport: failReport('compile_fail'),
  })
  const stopped = await pre.fn({}, enter)
  expect(stopped.messages).toHaveLength(0)

  saveState(join(workspace, '.canness', 'state.json'), {
    ...emptyState(), compileRetries: 1, lastReport: failReport('compile_fail'),
  })
  const steered = await pre.fn({}, enter)
  expect(steered.messages).toHaveLength(1)
  const text = steered.messages[0].content.find((block: { type: string; text?: string }) => block.type === 'text')?.text
  expect(text).toContain('compile_fail')
  expect(text).toContain('run_evaluation')

  const duplicate = await pre.fn({}, async () => ({
    kind: 'enter' as const,
    messages: [{ content: [{ type: 'text', text: text! }] }],
  }))
  expect(duplicate.messages).toHaveLength(1)
})
