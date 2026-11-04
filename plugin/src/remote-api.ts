/**
 * Host half of the CANNESS remote-connection surface: four routes on the
 * composition's `webServer`.
 *
 * Why routes and not a session command: a reachability check and an OAuth
 * sign-in are host facts about a machine, not turns in a conversation. The
 * command channel could only run while a live agent session existed, which is
 * exactly why the settings card's old "test connection" button never worked —
 * with no open session it had nowhere to run, and when it did run it wrote
 * command lifecycle events into the user's transcript.
 *
 * Trust has one home: every route asks the composition's `connection` service
 * for a rejection first (`requestRejection`), which carries the Host/Origin
 * fence and browser authentication. Bodies are bounded and validated at the
 * wire; nothing here echoes a token or a private key into a response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createTokenStore, dshHome, FileTokenStore, type TokenStore } from './cannlab/tokens.js'
import { connect, closeTunnel, currentTunnel } from './cannlab/connect.js'
import { openExternal } from './cannlab/open-browser.js'
import { DEFAULT_TOKEN_REF } from './cannlab/constants.js'
import { probeTcp } from './probe.js'
import type { CannlabFrame, CannlabStatus } from './cannlab/types.js'

/** Cordis function-plugin name. */
export const name = 'canness-remote'

/** The route carrier; `connection` is read reflectively so a minimal profile still mounts. */
export const inject = ['webServer']

/** Route paths, also used by the browser half. */
export const PROBE_PATH = '/canness/probe'
export const CANNLAB_CONNECT_PATH = '/canness/cannlab/connect'
export const CANNLAB_DISCONNECT_PATH = '/canness/cannlab/disconnect'
export const CANNLAB_STATUS_PATH = '/canness/cannlab/status'

/** The remote-connection plugin's configuration. */
export interface Config {
  /** Credential reference holding the GitCode refresh token. */
  tokenRef: string
  /** Directory the forwarding helper is downloaded into; empty uses the Harness home. */
  cacheRoot: string
  /** Directory temporary SSH keys are written under; empty uses the Harness home. */
  keyDir: string
  /** File the last connect attempt is recorded to; empty uses the Harness home. */
  logPath: string
  /** Default environment selector; empty picks the only running environment. */
  instance: string
}

export const Config = z.object({
  tokenRef: z.string().role('credential-ref').default(DEFAULT_TOKEN_REF).volatile(),
  cacheRoot: z.string().default('').volatile(),
  keyDir: z.string().default('').volatile(),
  logPath: z.string().default('').volatile(),
  instance: z.string().default('').volatile(),
})

/** The trust surface this module consumes. */
interface ConnectionLike {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * A string setting, or the fallback when the value is anything else.
 *
 * The Loader hands a plugin its *validated* config, and a `.volatile()` field
 * does not always arrive as the raw string: a volatile datum can surface as an
 * opaque object. Passing such a value into `node:path` is exactly how a
 * connect attempt used to die with `"path" argument must be of type string.
 * Received an instance of Object` before it could write its first log line.
 * Every config read therefore goes through here instead of trusting the type.
 * @param value - whatever the config carried for this key.
 * @param fallback - value to use when it is not a non-empty string.
 * @returns a usable string.
 */
function setting(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * The slice of `ctx.webServer` this module registers on.
 * Typed locally so the plugin does not depend on the carrier package: a
 * profile without a web server simply never mounts this plugin row.
 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Request bodies here are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024

/** The account name of the last successful sign-in, for the status line. */
let lastAccount = ''

/** JSON response (never cached: every answer is a live fact). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 with the one method a route accepts. */
function sendMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - the request being read.
 * @returns the body, or null when it exceeded the ceiling (stream drained).
 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse a JSON body only when the request really declared JSON. */
async function readJsonBody(req: IncomingMessage): Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, status: number, message: string }> {
  const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') return { ok: false, status: 415, message: 'content-type must be application/json' }
  const text = await readBoundedBody(req)
  if (text === null) return { ok: false, status: 413, message: 'request body is too large' }
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { ok: false, status: 400, message: 'body must be a JSON object' }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, status: 400, message: 'body is not valid JSON' }
  }
}

/** The token store for this deployment. */
function storeOf(ctx: Context, config: Config): TokenStore {
  const ref = setting(config.tokenRef, '')
  if (ref === '') return new FileTokenStore()
  return createTokenStore(ctx, ref)
}

/** Where temporary SSH keys go. */
function keyDirOf(config: Config): string {
  return setting(config.keyDir, join(dshHome(), 'canness', 'cannlab'))
}

/**
 * Register the four remote-connection routes.
 * @param ctx - the plugin context carrying `webServer` (and usually `connection`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const tokenStore = storeOf(ctx, config)
  const keyDir = keyDirOf(config)
  // Resolved once, through {@link setting}: a config value is not trusted to
  // be the type its schema declares.
  const resolved = {
    cacheRoot: setting(config.cacheRoot, ''),
    logPath: setting(config.logPath, ''),
    instance: setting(config.instance, ''),
  }
  const connection = (): ConnectionLike | undefined => ctx.get('connection') as ConnectionLike | undefined
  const webServer = (): WebServerLike => Reflect.get(ctx, 'webServer') as WebServerLike

  /** Answer an unauthenticated or cross-origin request; true when it was rejected. */
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const check = connection()
    if (check === undefined) return false
    const rejection = check.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => webServer().register({
    kind: 'exact',
    path: PROBE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, reason: 'unavailable', detail: body.message })
        return
      }
      const host = typeof body.value.host === 'string' ? body.value.host.trim() : ''
      const port = typeof body.value.port === 'number' ? body.value.port : Number(body.value.port)
      if (host.length === 0) {
        sendJson(res, 200, { ok: false, reason: 'empty-host' })
        return
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        sendJson(res, 200, { ok: false, reason: 'invalid-port' })
        return
      }
      sendJson(res, 200, await probeTcp(host, port))
    },
  }), `canness-remote: POST ${PROBE_PATH}`)

  ctx.effect(() => webServer().register({
    kind: 'exact',
    path: CANNLAB_STATUS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      const signedIn = (await tokenStore.read()) !== undefined
      const tunnel = currentTunnel()
      const status: CannlabStatus = { signedIn, account: lastAccount, tunnel: tunnel === null ? null : tunnel.target }
      sendJson(res, 200, status)
    },
  }), `canness-remote: GET ${CANNLAB_STATUS_PATH}`)

  ctx.effect(() => webServer().register({
    kind: 'exact',
    path: CANNLAB_DISCONNECT_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const closed = await closeTunnel()
      sendJson(res, 200, { ok: true, closed: closed !== null })
    },
  }), `canness-remote: POST ${CANNLAB_DISCONNECT_PATH}`)

  ctx.effect(() => webServer().register({
    kind: 'exact',
    path: CANNLAB_CONNECT_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        sendJson(res, body.status, { ok: false, reason: body.message })
        return
      }
      const requested = typeof body.value.instance === 'string' ? body.value.instance : ''
      const selector = requested.length > 0 ? requested : resolved.instance

      // Server-sent events: each stage is one frame, flushed as it happens, so a
      // slow or stuck step is visible in the card instead of looking like a hang.
      res.statusCode = 200
      res.setHeader('content-type', 'text/event-stream; charset=utf-8')
      res.setHeader('cache-control', 'no-cache, no-transform')
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      res.flushHeaders()

      // A panel that closes mid-flow cancels the attempt instead of leaving a
      // five-minute browser wait holding the fixed callback port.
      const controller = new AbortController()
      let open = true
      const closeStream = (): void => {
        open = false
        controller.abort()
      }
      req.once('close', closeStream)
      const write = (frame: CannlabFrame): void => {
        if (!open) return
        res.write(`data: ${JSON.stringify(frame)}\n\n`)
      }
      try {
        const tunnel = await connect({
          fetcher: async (input, init) => await fetch(input, init),
          tokenStore,
          ...resolved.cacheRoot === '' ? {} : { cacheRoot: resolved.cacheRoot },
          keyDir,
          ...resolved.logPath === '' ? {} : { logPath: resolved.logPath },
          ...selector === '' ? {} : { selector },
          signal: controller.signal,
          onEvent: (event) => { write({ kind: 'event', event }) },
          openBrowser: openExternal,
        })
        if (tunnel.account.length > 0) lastAccount = tunnel.account
        write({ kind: 'result', result: { ok: true, target: tunnel.target } })
      } catch (error) {
        write({
          kind: 'result',
          result: { ok: false, reason: error instanceof Error ? error.message : 'connect failed' },
        })
      } finally {
        req.off('close', closeStream)
        if (open) res.end()
      }
    },
  }), `canness-remote: POST ${CANNLAB_CONNECT_PATH}`)
}
