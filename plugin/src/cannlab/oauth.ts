/**
 * GitCode OAuth: the one interactive step of the CANNLab connection.
 *
 * The flow is the official Dev Space extension's: a fixed public client id,
 * a fixed loopback callback on port 3000, an authorization `code` exchanged
 * for an access token plus a refresh token. The `state` value is generated per
 * attempt and compared on the callback, which is what keeps a fixed callback
 * port safe: a forged callback cannot know it.
 *
 * The access token lives in memory for the duration of one operation. Only the
 * refresh token is persisted (see `tokens.ts`).
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  CALLBACK_PORT, CALLBACK_URI, GITCODE_AUTHORIZE_URL, GITCODE_CLIENT_ID,
  GITCODE_REFERER, GITCODE_TOKEN_URL, GITCODE_USER_URL, OAUTH_TIMEOUT_MS,
} from './constants.js'
import type { Fetcher } from './api.js'

/** What a sign-in reports back as it proceeds. */
export interface LoginHooks {
  /** A stage started; `detail` carries whatever the caller should show verbatim. */
  onStep(step: 'login-required' | 'login-awaiting' | 'login-exchange' | 'login-ok', message: string, detail?: string): void
  /** Open the authorization page. Returns false when no browser could be launched. */
  openBrowser(url: string): Promise<boolean>
}

/** Tokens and identity one successful sign-in produced. */
export interface LoginResult {
  accessToken: string
  /** Present when GitCode returned one; the only value worth persisting. */
  refreshToken?: string
  /** Display name of the signed-in GitCode account. */
  account: string
}

/** The OAuth token payload this client reads. */
interface TokenPayload {
  access_token?: unknown
  refresh_token?: unknown
}

/**
 * Build the authorization URL for one attempt.
 * @param state - the per-attempt nonce the callback must echo.
 * @returns the URL to open in the browser.
 */
export function buildAuthorizeUrl(state: string): string {
  const url = new URL(GITCODE_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', GITCODE_CLIENT_ID)
  url.searchParams.set('redirect_uri', CALLBACK_URI)
  url.searchParams.set('state', state)
  return url.toString()
}

/** Read a response body as JSON without echoing tokens into an error. */
async function readJson(response: { ok: boolean, status: number, text(): Promise<string> }, operation: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) throw new Error(`${operation}: HTTP ${String(response.status)}`)
  try {
    return text.length === 0 ? null : JSON.parse(text)
  } catch {
    throw new Error(`${operation}: response was not JSON`)
  }
}

/**
 * Exchange a one-time authorization code for tokens.
 * @param fetcher - `fetch` or a test double.
 * @param code - the callback's `code`.
 * @returns the token payload.
 */
export async function exchangeCode(fetcher: Fetcher, code: string): Promise<TokenPayload> {
  const url = new URL(GITCODE_TOKEN_URL)
  url.searchParams.set('grant_type', 'authorization_code')
  url.searchParams.set('code', code)
  url.searchParams.set('client_id', GITCODE_CLIENT_ID)
  const response = await fetcher(url.toString(), { method: 'POST', headers: { Referer: GITCODE_REFERER } })
  return await readJson(response, 'exchange oauth code') as TokenPayload
}

/**
 * Trade a refresh token for a fresh access token.
 * @param fetcher - `fetch` or a test double.
 * @param refreshToken - the persisted refresh token.
 * @returns the token payload; a rotated refresh token is included when GitCode rotates.
 */
export async function refreshAccessToken(fetcher: Fetcher, refreshToken: string): Promise<TokenPayload> {
  const url = new URL(GITCODE_TOKEN_URL)
  url.searchParams.set('grant_type', 'refresh_token')
  url.searchParams.set('refresh_token', refreshToken)
  const response = await fetcher(url.toString(), { method: 'POST', headers: { Referer: GITCODE_REFERER } })
  return await readJson(response, 'refresh oauth token') as TokenPayload
}

/**
 * Ask GitCode who the access token belongs to.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - a live access token.
 * @returns a display name, or an empty string when the profile carries none.
 */
export async function queryAccount(fetcher: Fetcher, accessToken: string): Promise<string> {
  const url = new URL(GITCODE_USER_URL)
  url.searchParams.set('access_token', accessToken)
  const profile = await readJson(await fetcher(url.toString()), 'query gitcode user') as
    { name?: unknown, login?: unknown } | null
  const name = profile?.name
  if (typeof name === 'string' && name.length > 0) return name
  const login = profile?.login
  return typeof login === 'string' ? login : ''
}

/** The page the browser lands on, so the tab itself explains what happened. */
function callbackPage(ok: boolean, detail: string): string {
  const title = ok ? 'CANNESS · 授权成功' : 'CANNESS · 授权失败'
  const hint = ok ? '可以关闭此页面，回到 DeepSeek Harness。' : '请回到 DeepSeek Harness 查看日志。'
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font:16px/1.6 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem">'
    + `<h1 style="font-size:1.4rem">${title}</h1><p>${detail}</p><p style="color:#666">${hint}</p></body></html>`
}

/** Reply with one plain page and finish the HTTP exchange. */
function reply(response: ServerResponse, status: number, html: string): void {
  // `connection: close` matters beyond tidiness: a keep-alive socket from the
  // browser would keep the listener bound, and the next connect attempt would
  // report the fixed callback port as busy.
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
  response.end(html)
}

/**
 * Listen for the one callback that carries an authorization code.
 * The server stops as soon as it settles, on success or failure, so a second
 * click never meets a busy port left behind by the first.
 * @param expectedState - the nonce this attempt issued.
 * @param timeoutMs - how long to wait.
 * @param signal - caller cancellation; the listener closes and the wait rejects.
 * @returns the authorization code.
 */
function waitForCode(expectedState: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? '/', CALLBACK_URI)
      if (requestUrl.pathname !== new URL(CALLBACK_URI).pathname) {
        response.writeHead(404).end()
        return
      }
      const failure = requestUrl.searchParams.get('error')
      if (failure !== null) {
        reply(response, 400, callbackPage(false, `GitCode 返回了 ${failure}。`))
        finish(new Error(`gitcode refused authorization: ${failure}`))
        return
      }
      const state = requestUrl.searchParams.get('state')
      if (state !== expectedState) {
        reply(response, 400, callbackPage(false, 'state 校验失败，这次回调不是本次登录发起的。'))
        finish(new Error('oauth callback failed the state check'))
        return
      }
      const code = requestUrl.searchParams.get('code')
      if (code === null || code.length === 0) {
        reply(response, 400, callbackPage(false, '回调里没有授权码。'))
        finish(new Error('oauth callback carried no code'))
        return
      }
      reply(response, 200, callbackPage(true, '一次性授权码已经交给本机进程。'))
      finish(null, code)
    })

    const finish = (error: Error | null, code?: string): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // The attempt settles only once the listener is really gone: a caller
      // that immediately retries would otherwise see the fixed port as busy
      // while the previous socket is still tearing down.
      let done = false
      let guard: NodeJS.Timeout | undefined
      const settle = (): void => {
        if (done) return
        done = true
        if (guard !== undefined) clearTimeout(guard)
        if (error === null) resolve(code ?? '')
        else reject(error)
      }
      guard = setTimeout(settle, 500)
      guard.unref()
      try {
        server.closeAllConnections()
        server.close(() => { settle() })
      } catch {
        settle()
      }
    }

    /** A caller that walks away must free the fixed callback port at once. */
    const onAbort = (): void => { finish(new Error('cancelled')) }
    if (signal?.aborted === true) {
      queueMicrotask(onAbort)
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish(new Error(`port ${String(CALLBACK_PORT)} is busy; GitCode calls back on that exact port, so free it and retry`))
        return
      }
      finish(error)
    })
    server.listen(CALLBACK_PORT, '127.0.0.1')
    timer = setTimeout(() => {
      finish(new Error(`no browser callback within ${String(Math.round(timeoutMs / 1000))}s`))
    }, timeoutMs)
  })
}

/**
 * Run one interactive sign-in.
 * @param fetcher - `fetch` or a test double.
 * @param hooks - progress reporting and browser launch.
 * @param timeoutMs - how long to wait for the callback.
 * @param signal - caller cancellation; the listener closes at once.
 * @returns tokens plus the account name.
 */
export async function interactiveLogin(
  fetcher: Fetcher,
  hooks: LoginHooks,
  timeoutMs: number = OAUTH_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<LoginResult> {
  const state = randomBytes(32).toString('hex')
  const authorizeUrl = buildAuthorizeUrl(state)
  // The listener is created before the browser opens, so the callback can
  // never arrive before we are ready for it.
  const waiting = waitForCode(state, timeoutMs, signal)
  hooks.onStep('login-required', 'GitCode authorization required.', authorizeUrl)
  hooks.onStep('login-awaiting', `Waiting for the browser callback on 127.0.0.1:${String(CALLBACK_PORT)}.`, authorizeUrl)
  const opened = await hooks.openBrowser(authorizeUrl)
  if (!opened) {
    hooks.onStep('login-awaiting', 'No browser could be launched; open the authorization URL manually.', authorizeUrl)
  }
  const code = await waiting
  hooks.onStep('login-exchange', 'Authorization code received; exchanging it for a token.')
  const token = await exchangeCode(fetcher, code)
  const accessToken = token.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('gitcode returned no access token')
  }
  const account = await queryAccount(fetcher, accessToken).catch(() => '')
  const refreshToken = typeof token.refresh_token === 'string' && token.refresh_token.length > 0 ? token.refresh_token : undefined
  hooks.onStep('login-ok', account.length > 0 ? `Signed in as ${account}.` : 'Signed in.', account)
  return {
    accessToken,
    account,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  }
}
