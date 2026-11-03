import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EvalCardController, EVAL_NS, type EvalSettings } from '../src/client/eval-card-controller.ts'
import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/** Resolve once a save settles: a scope mutation or a credentials call ran. */
async function settled(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the card to settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function fakeScope(section?: EvalSettings) {
  const listeners = new Set<() => void>()
  const opsApplied: SettingsFormPathOp[] = []
  let revision = 0
  const scope: SettingsFormScope<EvalSettings> = {
    getSnapshot: () => ({
      status: section === undefined ? 'unavailable' : 'ready',
      value: section,
      base: {},
      user: {},
      writable: true,
      revision,
    }),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate: async (ops) => { revision += 1; opsApplied.push(...ops); return true },
  }
  return { scope, opsApplied, notify: () => { for (const fn of listeners) fn() } }
}

function fakeCtx(store: { configuredRef?: string }) {
  const calls: { op: 'describe' | 'set'; ref?: string; value?: string }[] = []
  const ctx = {
    remote: {
      credentials: {
        describe: async (refs: string[]) => {
          calls.push({ op: 'describe' })
          return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: store.configuredRef === ref, writable: true }])) }
        },
        set: async (ref: string, value: string) => {
          calls.push({ op: 'set', ref, value })
          store.configuredRef = ref
          return { ok: true, value: undefined }
        },
      },
    },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const section: EvalSettings = {
  host: 'npu', port: 22, username: 'canness', privateKeyPath: '', inbox: '/in', outbox: '/out',
}

test('saving writes section fields through mutate and the password through credentials', async () => {
  const scope = fakeScope(section)
  const store: { configuredRef?: string } = {}
  const remote = fakeCtx(store)
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('host', 'npu2')
  face.edit('password', 'secret-pw')
  face.save()
  await settled(() => scope.opsApplied.length === 1 && remote.calls.some(call => call.op === 'set'))
  expect(scope.opsApplied).toEqual([{ op: 'set', path: ['host'], value: 'npu2' }])
  const setCall = remote.calls.find(call => call.op === 'set')
  expect(setCall).toMatchObject({ ref: 'CANNNESS_SSH_PASSWORD', value: 'secret-pw' })
  await settled(() => face.hooks.evalCard.getSnapshot().passwordConfigured === true)
  expect(face.hooks.evalCard.getSnapshot().passwordConfigured).toBe(true)
  card.dispose()
})

test('a blank password draft writes nothing and keeps the section mutation alone', async () => {
  const scope = fakeScope(section)
  const remote = fakeCtx({ configuredRef: 'CANNNESS_SSH_PASSWORD' })
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('host', 'npu2')
  face.save()
  await settled(() => scope.opsApplied.length === 1)
  expect(scope.opsApplied).toEqual([{ op: 'set', path: ['host'], value: 'npu2' }])
  expect(remote.calls.some(call => call.op === 'set')).toBe(false)
  card.dispose()
})

test('the auth mode derives from the key path and can be overridden', () => {
  const scope = fakeScope({ ...section, privateKeyPath: '/home/me/.ssh/id_rsa' })
  const remote = fakeCtx({})
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  expect(face.hooks.evalCard.getSnapshot().usePassword).toBe(false)
  face.setUsePassword(true)
  expect(face.hooks.evalCard.getSnapshot().usePassword).toBe(true)
  card.dispose()
})

test('passwordEnv in the section names the credential reference', async () => {
  const scope = fakeScope({ ...section, passwordEnv: 'CUSTOM_SSH_REF' })
  const remote = fakeCtx({})
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('password', 'pw')
  face.save()
  await settled(() => remote.calls.some(call => call.op === 'set'))
  expect(remote.calls.find(call => call.op === 'set')).toMatchObject({ ref: 'CUSTOM_SSH_REF' })
  card.dispose()
})

test('EVAL_NS is the canness-eval entry id', () => {
  expect(EVAL_NS).toBe('canness-eval')
})

test('a landed save shows a confirmation and a refused save does not', async () => {
  const saved = fakeScope(section)
  const savedRemote = fakeCtx({})
  const savedCard = new EvalCardController(savedRemote.ctx, saved.scope)
  const savedFace = savedCard.inject()
  savedFace.edit('host', 'npu2')
  savedFace.save()
  await settled(() => savedFace.hooks.evalCard.getSnapshot().showSaved === true)
  expect(savedFace.hooks.evalCard.getSnapshot().savedToken).toBe(1)
  savedFace.dismissSaved()
  expect(savedFace.hooks.evalCard.getSnapshot().showSaved).toBe(false)
  savedCard.dispose()

  const refused = fakeScope(section)
  refused.scope.mutate = async () => false
  const refusedCard = new EvalCardController(fakeCtx({}).ctx, refused.scope)
  const refusedFace = refusedCard.inject()
  refusedFace.edit('host', 'npu2')
  refusedFace.save()
  await settled(() => refusedFace.hooks.evalCard.getSnapshot().failed === true)
  expect(refusedFace.hooks.evalCard.getSnapshot().showSaved).toBe(false)
  refusedCard.dispose()
})

test('saving with nothing staged does not show a confirmation', async () => {
  const scope = fakeScope(section)
  const card = new EvalCardController(fakeCtx({}).ctx, scope.scope)
  const face = card.inject()
  face.save()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(face.hooks.evalCard.getSnapshot().showSaved).toBe(false)
  card.dispose()
})

test('saving in password mode clears a private key path', async () => {
  const scope = fakeScope({ ...section, privateKeyPath: '/home/me/.ssh/id_rsa' })
  const card = new EvalCardController(fakeCtx({}).ctx, scope.scope)
  const face = card.inject()
  face.setUsePassword(true)
  face.save()
  await settled(() => scope.opsApplied.some(op => op.op === 'unset' && op.path[0] === 'privateKeyPath'))
  expect(scope.opsApplied).toContainEqual({ op: 'unset', path: ['privateKeyPath'] })
  card.dispose()
})

test('the card is ready only when the saved section has a host, user, and credential', async () => {
  const missing = fakeScope({ ...section, host: '', username: '' })
  const missingCard = new EvalCardController(fakeCtx({ configuredRef: 'CANNNESS_SSH_PASSWORD' }).ctx, missing.scope)
  const missingFace = missingCard.inject()
  await settled(() => missingFace.hooks.evalCard.getSnapshot().passwordConfigured === true)
  expect(missingFace.hooks.evalCard.getSnapshot().ready).toBe(false)
  missingCard.dispose()

  const readyScope = fakeScope(section)
  const readyCard = new EvalCardController(fakeCtx({ configuredRef: 'CANNNESS_SSH_PASSWORD' }).ctx, readyScope.scope)
  const readyFace = readyCard.inject()
  await settled(() => readyFace.hooks.evalCard.getSnapshot().ready === true)
  expect(readyFace.hooks.evalCard.getSnapshot().readyTarget).toBe('canness@npu:22')
  expect(readyFace.hooks.evalCard.getSnapshot().readyAuth).toBe('password')
  readyCard.dispose()
})

test('test connection probes the draft host and port and ignores a second click while running', async () => {
  const scope = fakeScope(section)
  let release: (result: { ok: true }) => void = () => {}
  const calls: Array<[string, number]> = []
  const card = new EvalCardController(fakeCtx({}).ctx, scope.scope, (host, port) => {
    calls.push([host, port])
    return new Promise(resolve => { release = resolve })
  })
  const face = card.inject()
  face.edit('host', '10.0.0.8')
  face.edit('port', '2222')
  face.testConnection()
  expect(face.hooks.evalCard.getSnapshot().probeStatus).toBe('running')
  face.testConnection()
  expect(calls).toEqual([['10.0.0.8', 2222]])
  release({ ok: true })
  await settled(() => face.hooks.evalCard.getSnapshot().probeStatus === 'ok')
  card.dispose()
})

test('a rejected probe keeps the error message as the reason detail', async () => {
  const scope = fakeScope(section)
  const card = new EvalCardController(fakeCtx({}).ctx, scope.scope, async () => {
    throw new Error('session.list is not a function')
  })
  const face = card.inject()
  face.testConnection()
  await settled(() => face.hooks.evalCard.getSnapshot().probeStatus === 'error')
  expect(face.hooks.evalCard.getSnapshot().probeReason).toBe('unavailable')
  expect(face.hooks.evalCard.getSnapshot().probeDetail).toBe('session.list is not a function')
  card.dispose()
})

test('test connection reports an empty host without calling the probe', () => {
  const scope = fakeScope({ ...section, host: '' })
  const calls: string[] = []
  const card = new EvalCardController(fakeCtx({}).ctx, scope.scope, async () => {
    calls.push('called')
    return { ok: true }
  })
  const face = card.inject()
  face.edit('host', '  ')
  face.testConnection()
  expect(face.hooks.evalCard.getSnapshot().probeStatus).toBe('error')
  expect(face.hooks.evalCard.getSnapshot().probeReason).toBe('empty-host')
  expect(calls).toEqual([])
  card.dispose()
})
