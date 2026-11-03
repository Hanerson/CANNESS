import { expect, test } from 'vitest'
import { probeCommandLine } from '../src/probe-contract.ts'
import { probeThroughCaller, type ProbeRemote } from '../src/client/probe-remote.ts'

function remote(partial: {
  items?: Array<{ sessionId?: string; agentAvailable?: boolean }>
  listOk?: boolean
  listError?: { code?: string; message?: string }
  execute?: ProbeRemote['commands']['execute']
}): ProbeRemote {
  return {
    session: {
      list: async () => ({
        ok: partial.listOk ?? true,
        value: { items: partial.items ?? [] },
        ...partial.listOk === false ? { error: partial.listError } : {},
      }),
    },
    commands: {
      execute: partial.execute ?? (async () => ({ ok: true, value: { result: { kind: 'success', text: 'reachable' } } })),
    },
  }
}

test('probeThroughCaller asks the live session to run the tcp command', async () => {
  const lines: string[] = []
  const outcome = await probeThroughCaller(remote({
    items: [
      { sessionId: 'old', agentAvailable: false },
      { sessionId: 'live', agentAvailable: true },
    ],
    execute: async (agent, line) => {
      lines.push(`${agent} ${line}`)
      return { ok: true, value: { result: { kind: 'success', text: 'reachable' } } }
    },
  }), 'npu', 22)
  expect(outcome).toEqual({ ok: true })
  expect(lines).toEqual([`live ${probeCommandLine('npu', 22)}`])
})

test('probeThroughCaller reports no session and an unreachable command result', async () => {
  await expect(probeThroughCaller(remote({ items: [] }), 'npu', 22)).resolves.toEqual({ ok: false, reason: 'no-session' })
  await expect(probeThroughCaller(remote({
    items: [{ sessionId: 'live', agentAvailable: true }],
    execute: async () => ({ ok: true, value: { result: { kind: 'error', text: 'unreachable:timeout' } } }),
  }), 'npu', 22)).resolves.toEqual({ ok: false, reason: 'unreachable', detail: 'timeout' })
  await expect(probeThroughCaller(remote({ listOk: false }), 'npu', 22)).resolves.toEqual({
    ok: false, reason: 'unavailable', detail: 'list:unknown',
  })
})

test('probeThroughCaller names the remote error when the session list fails', async () => {
  await expect(probeThroughCaller(remote({
    listOk: false,
    listError: { code: 'gateway/internal', message: 'session store down' },
  }), 'npu', 22)).resolves.toEqual({
    ok: false, reason: 'unavailable', detail: 'list:gateway/internal: session store down',
  })
})

test('probeThroughCaller names a thrown session-list error', async () => {
  const broken: ProbeRemote = {
    session: { list: async () => { throw new Error('session.list is not a function') } },
    commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success', text: 'reachable' } } }) },
  }
  await expect(probeThroughCaller(broken, 'npu', 22)).resolves.toEqual({
    ok: false, reason: 'unavailable', detail: 'list:session.list is not a function',
  })
})

test('probeThroughCaller says the probe command is missing when execute returns no value', async () => {
  await expect(probeThroughCaller(remote({
    items: [{ sessionId: 'live', agentAvailable: true }],
    execute: async () => ({ ok: true, value: undefined }),
  }), 'npu', 22)).resolves.toEqual({ ok: false, reason: 'unavailable', detail: 'command-missing' })
})

test('probeThroughCaller names the remote error when command execute fails', async () => {
  await expect(probeThroughCaller(remote({
    items: [{ sessionId: 'live', agentAvailable: true }],
    execute: async () => ({ ok: false, error: { code: 'gateway/bad-request', message: 'bad agent' } }),
  }), 'npu', 22)).resolves.toEqual({
    ok: false, reason: 'unavailable', detail: 'execute:gateway/bad-request: bad agent',
  })
})

test('probeThroughCaller names a thrown execute error', async () => {
  await expect(probeThroughCaller(remote({
    items: [{ sessionId: 'live', agentAvailable: true }],
    execute: async () => { throw new Error('commands.execute is not a function') },
  }), 'npu', 22)).resolves.toEqual({
    ok: false, reason: 'unavailable', detail: 'execute:commands.execute is not a function',
  })
})

test('probeThroughCaller names a command result that has no kind', async () => {
  await expect(probeThroughCaller(remote({
    items: [{ sessionId: 'live', agentAvailable: true }],
    execute: async () => ({ ok: true, value: { result: {} } }),
  }), 'npu', 22)).resolves.toEqual({ ok: false, reason: 'unavailable', detail: 'result-missing' })
})
