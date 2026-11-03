import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Volatile } from '@deepseek-ai/cordis'
import * as knowledge from '../src/knowledge.ts'
import * as generator from '../src/generator.ts'
import * as evalPlugin from '../src/eval.ts'
import * as loop from '../src/loop.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote, type RemoteHost } from '../src/remote.ts'
import type { EvalReport } from '../src/report.ts'
import { saveState } from '../src/state-file.ts'

const vol = <T,>(value: T): Volatile<T> => ({ get: () => value })

function evalConfig(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    workspace,
    host: vol('npu'), port: vol(22), username: vol('canness'),
    privateKeyPath: vol(''), passwordEnv: vol('CANNNESS_SSH_PASSWORD'),
    inbox: vol('/in'), outbox: vol('/out'), timeoutSec: vol(0), pollIntervalMs: vol(1),
    maxIterations: vol(10), maxCompileRetries: vol(3), negativeStreakLimit: vol(3), convergenceThreshold: vol(0.05),
    bootstrap: vol(true), bootstrapCommand: vol(''),
    ...overrides,
  }
}

function fakeCtx(credentials?: { resolve: (ref: string) => Promise<{ value: string } | undefined> }) {
  const tools: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const listeners: { event: string; fn: Function }[] = []
  return {
    tools: { register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) { tools.push(tool) } },
    on(event: string, fn: Function) { listeners.push({ event, fn }) },
    get(name: string) { return name === 'credentials' ? credentials : undefined },
    toolsRegistered: tools,
    listeners,
  }
}

test('registers a tcp probe command when the commands service is present', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const dials: Array<{ host: string; port: number }> = []
  let definition: { name: string; handler: (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }> } | undefined
  const ctx = {
    tools: { register() {} },
    get(name: string) {
      if (name !== 'commands') return undefined
      return {
        register(def: typeof definition) {
          definition = def
          return () => {}
        },
      }
    },
    effect(run: () => () => void) { run() },
  }
  evalPlugin.apply(ctx as never, evalConfig(workspace), async () => {
    throw new Error('evaluation connect is not used by the probe')
  }, async (host, port) => {
    dials.push({ host, port })
    if (host === 'down') throw new Error('connect ECONNREFUSED')
  })
  expect(definition?.name).toBe('canness-probe')
  await expect(definition!.handler({ rawInput: ' npu 2222' })).resolves.toEqual({ kind: 'success', text: 'reachable' })
  expect(dials).toEqual([{ host: 'npu', port: 2222 }])
  await expect(definition!.handler({ rawInput: 'down 22' })).resolves.toMatchObject({ kind: 'error', text: 'unreachable:connect ECONNREFUSED' })
  await expect(definition!.handler({ rawInput: '   ' })).resolves.toEqual({ kind: 'error', text: 'empty-host' })
})

test('registers the five tools and two loop listeners', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-plugin-'))
  const kb = fakeCtx()
  knowledge.apply(kb as never, { kbRoot: new URL('../knowledge_base/', import.meta.url).pathname })
  const gen = fakeCtx()
  generator.apply(gen as never, { workspace })
  const ev = fakeCtx()
  evalPlugin.apply(ev as never, evalConfig(workspace, { host: vol(''), inbox: vol('/tmp/canness/inbox'), outbox: vol('/tmp/canness/outbox'), timeoutSec: vol(1800), pollIntervalMs: vol(2000) }))
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
  evalPlugin.apply(ev as never, evalConfig(workspace, { host: vol(''), timeoutSec: vol(1) }),
    async () => { connected = true; throw new Error('connected') })
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

function trackedRemote(events: string[], upload?: () => Promise<void>): { files: RemoteHost; remote: MemoryRemote } {
  const remote = new MemoryRemote()
  const files: RemoteHost = {
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
    // Bootstrap operations stay out of `events`; `remote.execCalls` inspects them.
    async mkdirp(dir) { await remote.mkdirp(dir) },
    async put(local, path) { await remote.put(local, path) },
    async stat(path) { return remote.stat(path) },
    async exec(command) { return remote.exec(command) },
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
  evalPlugin.apply(finishedCtx as never, evalConfig(finished.workspace, { privateKeyPath: vol(join(finished.workspace, 'id_key')) }),
    async () => finishedRemote.files)
  const finishedValue = await finishedCtx.toolsRegistered[0]!.execute({})
  expect(finishedValue).toMatchObject({ status: 'compile_fail', summary: 'failed compile' })
  expect(finishedEvents).toEqual(['upload', 'remove', 'read', 'close'])

  const failedEvents: string[] = []
  const failed = readyPackage()
  const failedRemote = trackedRemote(failedEvents, async () => { throw new Error('upload failed') })
  const failedCtx = fakeCtx()
  evalPlugin.apply(failedCtx as never, evalConfig(failed.workspace, { privateKeyPath: vol(join(failed.workspace, 'id_key')) }),
    async () => failedRemote.files)
  await expect(failedCtx.toolsRegistered[0]!.execute({})).rejects.toThrow('upload failed')
  expect(failedEvents).toEqual(['upload', 'close'])
})

test('run_evaluation closes after a poll timeout and does not connect when already stopped', async () => {
  const timeoutEvents: string[] = []
  const timed = readyPackage()
  const timedRemote = trackedRemote(timeoutEvents)
  const timeoutCtx = fakeCtx()
  evalPlugin.apply(timeoutCtx as never, evalConfig(timed.workspace, { privateKeyPath: vol(join(timed.workspace, 'id_key')) }),
    async () => timedRemote.files)
  const timedOut = await timeoutCtx.toolsRegistered[0]!.execute({})
  expect(timedOut).toMatchObject({ status: 'timeout' })
  expect(timeoutEvents).toEqual(['upload', 'remove', 'read', 'close'])

  const stoppedEvents: string[] = []
  const stopped = readyPackage()
  saveState(join(stopped.workspace, '.canness', 'state.json'), {
    ...emptyState(), generationId: stopped.generationId, timeouts: 2,
  })
  const stoppedCtx = fakeCtx()
  evalPlugin.apply(stoppedCtx as never, evalConfig(stopped.workspace, { privateKeyPath: vol(join(stopped.workspace, 'id_key')) }),
    async () => { stoppedEvents.push('connect'); throw new Error('connected') })
  const stoppedValue = await stoppedCtx.toolsRegistered[0]!.execute({})
  expect(stoppedValue).toMatchObject({ status: 'error', summary: 'stopped: timeouts' })
  expect(stoppedEvents).toEqual([])
})

function keyFile(workspace: string): string {
  writeFileSync(join(workspace, 'id_key'), 'KEY')
  return join(workspace, 'id_key')
}

test('a failed bootstrap returns an error report without uploading, polling or writing state', async () => {
  const pkg = readyPackage()
  const remote = new MemoryRemote()
  remote.execHandler = command => ({ code: 1, stdout: '', stderr: command.includes('pgrep') ? '' : 'not found' })
  const statePath = join(pkg.workspace, '.canness', 'state.json')
  const before = readFileSync(statePath, 'utf8')
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(keyFile(pkg.workspace)) }),
    async () => remote)
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error' })
  expect((value as { summary: string }).summary).toMatch(/^remote bootstrap failed: /)
  expect((value as { summary: string }).summary).toContain('python')
  expect(readFileSync(statePath, 'utf8')).toBe(before)
  expect(remote.reads).toBe(0)
  expect([...remote.files.keys()].some(path => path.startsWith('/in/'))).toBe(false)
})

test('bootstrap: false keeps the upload-then-poll behaviour', async () => {
  const pkg = readyPackage()
  const remote = new MemoryRemote()
  const resultPath = `/out/${pkg.generationId}/results.json`
  remote.appearOnRead(resultPath, Buffer.from(JSON.stringify({
    generationId: pkg.generationId,
    status: 'pass',
    compile: { ok: true, log: '' },
    correctness: { ok: true, maxRelativeError: 0 },
    performance: { kernelTimeUs: 120, targetUs: 150 },
    summary: 'ok',
  })), 1)
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, {
    privateKeyPath: vol(keyFile(pkg.workspace)),
    bootstrap: vol(false),
  }), async () => remote)
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'pass' })
  expect(remote.execCalls).toEqual([])
  expect(remote.files.has(`/in/${pkg.generationId}/manifest.json`)).toBe(true)
  expect(remote.reads).toBeGreaterThan(0)
})

test('the private key wins over a stored password', async () => {
  const pkg = readyPackage()
  const connected: unknown[] = []
  const ctx = fakeCtx({ resolve: async () => ({ value: 'pw' }) })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(keyFile(pkg.workspace)) }),
    async opts => { connected.push(opts); return trackedRemote([]).files })
  await ctx.toolsRegistered[0]!.execute({})
  expect(connected[0]).toMatchObject({ privateKey: 'KEY' })
  expect((connected[0] as Record<string, unknown>).password).toBeUndefined()
})

test('a stored password is used when no key path is configured', async () => {
  const pkg = readyPackage()
  const refs: string[] = []
  const connected: unknown[] = []
  const ctx = fakeCtx({ resolve: async ref => { refs.push(String(ref)); return { value: 'pw' } } })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async opts => { connected.push(opts); return trackedRemote([]).files })
  await ctx.toolsRegistered[0]!.execute({})
  expect(refs).toEqual(['CANNNESS_SSH_PASSWORD'])
  expect(connected[0]).toMatchObject({ password: 'pw' })
  expect((connected[0] as Record<string, unknown>).privateKey).toBeUndefined()
})

test('both credentials missing reports ssh credentials missing without connecting', async () => {
  const pkg = readyPackage()
  let connected = false
  const ctx = fakeCtx({ resolve: async () => undefined })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async () => { connected = true; throw new Error('connected') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh credentials missing' })
  expect(connected).toBe(false)
})

test('an absent credentials service degrades to the missing-credentials report', async () => {
  const pkg = readyPackage()
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async () => { throw new Error('connected') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh credentials missing' })
})

test('a connect failure becomes an error report carrying the reason', async () => {
  const pkg = readyPackage()
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(keyFile(pkg.workspace)) }),
    async () => { throw new Error('All configured authentication methods failed') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error' })
  expect((value as { summary: string }).summary).toContain('All configured authentication methods failed')
})

test('passwordEnv names the resolved reference', async () => {
  const pkg = readyPackage()
  const refs: string[] = []
  const ctx = fakeCtx({ resolve: async ref => { refs.push(String(ref)); return { value: 'pw' } } })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(''), passwordEnv: vol('CUSTOM_SSH_REF') }),
    async () => trackedRemote([]).files)
  await ctx.toolsRegistered[0]!.execute({})
  expect(refs).toEqual(['CUSTOM_SSH_REF'])
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
