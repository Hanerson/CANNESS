/**
 * The remote-connection routes, mounted on a real HTTP listener.
 *
 * The trust fence is a framework behaviour the shipped plugins share, so the
 * fake composition here either admits or rejects every request explicitly. What
 * this file pins down is the part this plugin owns: route matching, method and
 * body validation, the reachability answer, the SSE framing of the connect
 * flow, and the fact that a rejected peer never reaches any of it.
 */

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply, CANNLAB_CONNECT_PATH, CANNLAB_DISCONNECT_PATH, CANNLAB_STATUS_PATH, PROBE_PATH, Config,
} from '../src/remote-api.js'
import * as connectApi from '../src/cannlab/connect.js'
import type { CannlabFrame } from '../src/cannlab/types.js'

// Tests must never read the developer's real Harness home: one successful
// connect leaves a GitCode token there, and a "fresh composition" test would
// then report a stored session that this test never created.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'canness-api-home-'))

/** One registered route. */
interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** A composition that answers the four services `apply` reads. */
function fakeComposition(options: {
  reject?: boolean
  credentials?: { resolve(ref: string): Promise<{ value: string } | undefined>, set(): Promise<void>, unset(): Promise<void> }
  webServer?: { register(route: Route): () => void }
} = {}) {
  const routes: Route[] = []
  const webServer = options.webServer ?? {
    register(route: Route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const ctx = {
    webServer,
    effect(fn: () => unknown) { return fn() },
    get(name: string) {
      if (name === 'webServer') return webServer
      if (name === 'connection') {
        return { requestRejection: () => options.reject === true ? 401 : undefined }
      }
      if (name === 'credentials') return options.credentials
      return undefined
    },
  }
  return { ctx: ctx as unknown as Context, routes }
}

/** A server dispatching by the route table the plugin registered. */
async function serve(routes: Route[]): Promise<{ base: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find(candidate => candidate.kind === 'exact'
      ? candidate.path === path
      : path === candidate.path || path.startsWith(`${candidate.path}/`))
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${String(port)}`,
    close: async () => { await new Promise<void>(resolve => { server.close(() => { resolve() }) }) },
  }
}

/** The configuration a test uses; the cache and key directories stay unused. */
const config = {
  tokenRef: 'CANNLAB_GITCODE_TOKEN',
  cacheRoot: '',
  keyDir: '',
  logPath: join(mkdtempSync(join(tmpdir(), 'canness-api-')), 'connect.log'),
  instance: '',
} satisfies Config

/** Captured before any test stubs the global, for requests that must be real. */
const realFetch = globalThis.fetch

async function signedInFrom(routes: Route[]): Promise<boolean> {
  const response = { setHeader() {}, end: vi.fn() }
  await routes.find(route => route.path === CANNLAB_STATUS_PATH)!.handler({ method: 'GET' }, response)
  return JSON.parse(response.end.mock.calls[0][0]).signedIn as boolean
}

async function postConnect(routes: Route[]): Promise<void> {
  const request = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
  })
  const response = { setHeader() {}, flushHeaders() {}, write() {}, end() {} }
  await routes.find(route => route.path === CANNLAB_CONNECT_PATH)!.handler(request, response)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('trust fence', () => {
  it('rejects every route before its handler runs', async () => {
    const { ctx, routes } = fakeComposition({ reject: true })
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const probe = await fetch(`${server.base}${PROBE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const status = await fetch(`${server.base}${CANNLAB_STATUS_PATH}`)
      const connect = await fetch(`${server.base}${CANNLAB_CONNECT_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect([probe.status, status.status, connect.status]).toEqual([401, 401, 401])
    } finally {
      await server.close()
    }
  })
})

describe('probe route', () => {
  it('answers reachable for a port that accepts a connection', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    // The test's own listener is the reachable target.
    const server = await serve(routes)
    try {
      const { port } = new URL(server.base)
      const response = await fetch(`${server.base}${PROBE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: Number(port) }),
      })
      expect(await response.json()).toEqual({ ok: true })
    } finally {
      await server.close()
    }
  })

  it('answers unreachable with the socket error for a closed port', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    const server = await serve(routes)
    try {
      // Bind a port, learn it, then free it: nothing listens there any more.
      const closed = createServer(() => {})
      await new Promise<void>(resolve => { closed.listen(0, '127.0.0.1', resolve) })
      const { port } = closed.address() as AddressInfo
      await new Promise<void>(resolve => { closed.close(() => { resolve() }) })
      const response = await fetch(`${server.base}${PROBE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port }),
      })
      const body = await response.json() as { ok: boolean, reason: string, detail?: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toBe('unreachable')
      expect(body.detail).toBeDefined()
    } finally {
      await server.close()
    }
  })

  it('reports the two input problems without opening a socket', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    const server = await serve(routes)
    const post = async (body: unknown): Promise<unknown> => {
      const response = await fetch(`${server.base}${PROBE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await response.json()
    }
    try {
      expect(await post({ host: '  ', port: 22 })).toEqual({ ok: false, reason: 'empty-host' })
      expect(await post({ host: '127.0.0.1', port: 70000 })).toEqual({ ok: false, reason: 'invalid-port' })
      expect(await post({ host: '127.0.0.1', port: 'abc' })).toEqual({ ok: false, reason: 'invalid-port' })
    } finally {
      await server.close()
    }
  })

  it('refuses the wrong method and a non-JSON body', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const get = await fetch(`${server.base}${PROBE_PATH}`)
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
      const text = await fetch(`${server.base}${PROBE_PATH}`, {
        method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'host=127.0.0.1',
      })
      expect(text.status).toBe(415)
    } finally {
      await server.close()
    }
  })
})

describe('cannlab status route', () => {
  it('reports no session and no tunnel on a fresh composition', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const response = await fetch(`${server.base}${CANNLAB_STATUS_PATH}`)
      expect(await response.json()).toEqual({ signedIn: false, account: '', tunnel: null })
    } finally {
      await server.close()
    }
  })

  it('reports a stored session through the credential seam', async () => {
    const { ctx, routes } = fakeComposition({
      credentials: {
        resolve: async () => ({ value: 'refresh-token' }),
        set: async () => {},
        unset: async () => {},
      },
    })
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const response = await fetch(`${server.base}${CANNLAB_STATUS_PATH}`)
      expect(await response.json()).toMatchObject({ signedIn: true })
    } finally {
      await server.close()
    }
  })
})

describe('disconnect route', () => {
  it('confirms with nothing to close', async () => {
    const { ctx, routes } = fakeComposition()
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const response = await fetch(`${server.base}${CANNLAB_DISCONNECT_PATH}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(await response.json()).toEqual({ ok: true, closed: false })
    } finally {
      await server.close()
    }
  })
})

describe('connect route', () => {
  it('uses the five values from the installed Schemastery config', async () => {
    const settings = {
      tokenRef: 'CANNLAB_GITCODE_TOKEN',
      cacheRoot: join(process.env.DSH_HOME!, 'configured-cache'),
      keyDir: join(process.env.DSH_HOME!, 'configured-key-dir'),
      logPath: join(process.env.DSH_HOME!, 'configured-log.txt'),
      instance: 'configured-instance',
    }
    const schemaConfig = Config(settings)
    expect(schemaConfig.tokenRef.get()).toBe(settings.tokenRef)
    const connect = vi.spyOn(connectApi, 'connect').mockRejectedValue(new Error('test stopped before sign-in'))
    const credentials = {
      resolve: async (ref: string) => ref === settings.tokenRef ? { value: 'fixture-token' } : undefined,
      set: async () => {},
      unset: async () => {},
    }
    const { ctx, routes } = fakeComposition({ credentials })
    apply(ctx, schemaConfig)
    expect(await signedInFrom(routes)).toBe(true)
    await postConnect(routes)
    expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cacheRoot: settings.cacheRoot, keyDir: settings.keyDir, logPath: settings.logPath, selector: settings.instance,
    }))
  })

  const blank = { tokenRef: '', cacheRoot: '', keyDir: '', logPath: '', instance: '' }
  it.each([
    ['opaque settings', Object.fromEntries(Object.keys(blank).map(key => [key, { opaque: true }])) as unknown as Config],
    ['empty settings', Config(blank)],
  ] as const)('uses file-backed credentials and default paths for %s', async (_name, settings) => {
    const connect = vi.spyOn(connectApi, 'connect').mockRejectedValue(new Error('test stopped before sign-in'))
    const credentials = {
      resolve: async () => ({ value: 'fixture-token' }),
      set: async () => {},
      unset: async () => {},
    }
    const { ctx, routes } = fakeComposition({ credentials })
    apply(ctx, settings)
    expect(await signedInFrom(routes)).toBe(false)
    await postConnect(routes)
    const options = connect.mock.calls[0][0]
    expect(options.keyDir).toBe(join(process.env.DSH_HOME!, 'canness', 'cannlab'))
    expect(options.cacheRoot).toBeUndefined()
    expect(options.logPath).toBeUndefined()
    expect(options.selector).toBeUndefined()
  })

  it('streams event frames and one result frame over a real socket', async () => {
    const credentials = {
      resolve: async () => ({ value: 'refresh-token' }),
      set: async () => {},
      unset: async () => {},
    }
    // The token refresh succeeds; the instance listing is the first cloud call
    // and is made to fail, so the flow stops with a reportable reason and
    // never reaches the browser or the forwarding helper.
    const fetcher = vi.fn(async (input: string) => {
      const body = input.includes('oauth/token')
        ? { access_token: 'at-123' }
        : { error_code: '1401', result: null }
      return { ok: true, status: 200, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) }
    })
    vi.stubGlobal('fetch', fetcher)
    // The stub above also replaces the global the test itself would call, so
    // the request to the mounted server is issued with the real implementation.
    const clientFetch = realFetch

    const { ctx, routes } = fakeComposition({ credentials })
    apply(ctx, config)
    const server = await serve(routes)
    try {
      const response = await clientFetch(`${server.base}${CANNLAB_CONNECT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ instance: '' }),
      })
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const text = await response.text()
      const frames = text.split('\n\n')
        .filter(block => block.trim().length > 0)
        .map(block => JSON.parse(block.replace(/^data: /u, '')) as CannlabFrame)

      const events = frames.filter(frame => frame.kind === 'event')
        .map(frame => frame.kind === 'event' ? frame.event.step : '')
      expect(events).toContain('checking-login')
      expect(events).toContain('listing')

      const results = frames.filter(frame => frame.kind === 'result')
      expect(results).toHaveLength(1)
      const result = results[0]
      expect(result.kind).toBe('result')
      if (result.kind === 'result') {
        expect(result.result.ok).toBe(false)
        if (!result.result.ok) expect(result.result.reason).toContain('error_code 1401')
      }

      // The same stages are on disk, so a failed attempt survives a reload.
      const trace = readFileSync(config.logPath, 'utf8')
      expect(trace).toContain('CANNLab connect attempt')
      expect(trace).toContain('listing')
      expect(trace).toContain('error_code 1401')
    } finally {
      await server.close()
    }
  })
})
