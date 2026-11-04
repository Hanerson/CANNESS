/** The CANNESS card's CANNLab panel: staging, logging, and the running-state guard. */

import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  EvalCardController, type CannlabApi, type EvalSettings,
} from '../src/client/eval-card-controller.ts'
import type { CannlabEvent, CannlabTarget } from '../src/cannlab/types.ts'

/** Resolve once a save settles. */
async function settled(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the card to settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A scope recording the writes a save would perform. */
function fakeScope(section: EvalSettings) {
  const listeners = new Set<() => void>()
  const opsApplied: SettingsFormPathOp[] = []
  const scope: SettingsFormScope<EvalSettings> = {
    getSnapshot: () => ({ status: 'ready', value: section, base: {}, user: {}, writable: true, revision: 0 }),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate: async (ops) => { opsApplied.push(...ops); return true },
  }
  return { scope, opsApplied }
}

/** The minimum context the controller reads: the credentials namespace. */
function fakeCtx(): Context {
  return {
    remote: {
      credentials: {
        describe: async (refs: string[]) => ({
          ok: true,
          value: Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }])),
        }),
        set: async () => ({ ok: true, value: undefined }),
      },
    },
  } as unknown as Context
}

const section: EvalSettings = {
  host: '', port: 22, username: '', privateKeyPath: '', inbox: '/in', outbox: '/out',
}

const target: CannlabTarget = {
  host: '127.0.0.1',
  port: 20022,
  username: 'developer',
  privateKeyPath: '/keys/a/id_abc',
  instance: 'DevHW',
  instanceId: 'a',
}

/** An API double that reports the given events then resolves one result. */
function fakeApi(
  events: CannlabEvent[],
  result: unknown,
  extra: Partial<CannlabApi> = {},
): CannlabApi & { calls: number, instances: string[] } {
  const api = {
    calls: 0,
    instances: [] as string[],
    connect: async (instance: string, onEvent: (event: CannlabEvent) => void) => {
      api.calls += 1
      api.instances.push(instance)
      for (const event of events) onEvent(event)
      return result as never
    },
    status: async () => null,
    disconnect: async () => true,
    ...extra,
  }
  return api as CannlabApi & { calls: number, instances: string[] }
}

/** One host-side log line. */
function event(step: CannlabEvent['step'], message: string, detail?: string): CannlabEvent {
  return { step, level: 'info', message, ...detail === undefined ? {} : { detail }, at: 1 }
}

test('a successful connect logs every step and stages the tunnel into the form', async () => {
  const fake = fakeScope(section)
  const api = fakeApi(
    [event('login-awaiting', 'Waiting for the browser callback.', 'https://gitcode.com/oauth'), event('done', 'Connected.')],
    { ok: true, target },
  )
  const card = new EvalCardController(fakeCtx(), fake.scope, undefined, api)
  const face = card.inject()
  face.connectCannlab()
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.status === 'ok')

  const state = face.hooks.evalCard.getSnapshot()
  expect(state.cannlab.lines.map(line => line.text)).toEqual(['Waiting for the browser callback.', 'Connected.'])
  expect(state.cannlab.applied).toBe('developer@127.0.0.1:20022')
  expect(state.cannlab.authorizeUrl).toBe('https://gitcode.com/oauth')
  expect(fake.opsApplied).toEqual([
    { op: 'set', path: ['host'], value: '127.0.0.1' },
    { op: 'set', path: ['port'], value: 20022 },
    { op: 'set', path: ['username'], value: 'developer' },
    { op: 'set', path: ['privateKeyPath'], value: '/keys/a/id_abc' },
  ])
  // A discovered key path implies key auth; a clear here would undo the discovery.
  expect(state.usePassword).toBe(false)
  card.dispose()
})

test('a failed connect keeps the reason and stages nothing', async () => {
  const fake = fakeScope(section)
  const api = fakeApi([event('listing', 'Listing.')], { ok: false, reason: 'no environment is running' })
  const card = new EvalCardController(fakeCtx(), fake.scope, undefined, api)
  const face = card.inject()
  face.connectCannlab()
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.status === 'error')
  expect(face.hooks.evalCard.getSnapshot().cannlab.reason).toBe('no environment is running')
  expect(fake.opsApplied).toEqual([])
  card.dispose()
})

test('a second click while the flow runs does not start another attempt', async () => {
  const fake = fakeScope(section)
  let release: (value: { ok: true, target: CannlabTarget }) => void = () => {}
  let started = 0
  const api = fakeApi([], { ok: true, target }, {
    connect: async () => {
      started += 1
      return await new Promise(resolve => { release = resolve })
    },
  })
  const card = new EvalCardController(fakeCtx(), fake.scope, undefined, api)
  const face = card.inject()
  face.connectCannlab()
  face.connectCannlab()
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.status === 'running')
  expect(started).toBe(1)
  release({ ok: true, target })
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.status === 'ok')
  card.dispose()
})

test('disconnect clears the staged tunnel', async () => {
  const fake = fakeScope(section)
  const api = fakeApi([], { ok: true, target })
  const card = new EvalCardController(fakeCtx(), fake.scope, undefined, api)
  const face = card.inject()
  face.connectCannlab()
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.applied !== '')
  face.disconnectCannlab()
  await settled(() => face.hooks.evalCard.getSnapshot().cannlab.applied === '')
  expect(face.hooks.evalCard.getSnapshot().cannlab.status).toBe('idle')
  card.dispose()
})

test('the panel reads the host tunnel state on refresh', async () => {
  const fake = fakeScope(section)
  const api = fakeApi([], { ok: false, reason: 'unused' }, {
    status: async () => ({ signedIn: true, account: 'me', tunnel: target }),
  })
  const card = new EvalCardController(fakeCtx(), fake.scope, undefined, api)
  const face = card.inject()
  await card.refreshCannlab()
  const state = face.hooks.evalCard.getSnapshot()
  expect(state.cannlab.signedIn).toBe(true)
  expect(state.cannlab.account).toBe('me')
  expect(state.cannlab.applied).toBe('developer@127.0.0.1:20022')
  card.dispose()
})

test('a named environment is forwarded, and a blank one asks the host to choose', async () => {
  const named = fakeApi([], { ok: true, target })
  const namedCard = new EvalCardController(fakeCtx(), fakeScope(section).scope, undefined, named)
  const namedFace = namedCard.inject()
  namedFace.setCannlabInstance('  NPU-01  ')
  namedFace.connectCannlab()
  await settled(() => namedFace.hooks.evalCard.getSnapshot().cannlab.status === 'ok')
  expect(named.instances).toEqual(['NPU-01'])
  namedCard.dispose()

  const blank = fakeApi([], { ok: true, target })
  const blankCard = new EvalCardController(fakeCtx(), fakeScope(section).scope, undefined, blank)
  const blankFace = blankCard.inject()
  blankFace.connectCannlab()
  await settled(() => blankFace.hooks.evalCard.getSnapshot().cannlab.status === 'ok')
  expect(blank.instances).toEqual([''])
  blankCard.dispose()
})
