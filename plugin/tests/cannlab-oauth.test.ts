/**
 * The OAuth callback server, exercised against a real loopback listener.
 * The browser is simulated by calling the exact callback URL GitCode would,
 * which is the only way to prove the state check and the exchange wiring
 * without an interactive sign-in.
 */

import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildAuthorizeUrl, interactiveLogin } from '../src/cannlab/oauth.js'
import type { Fetcher } from '../src/cannlab/api.js'

/** A fetch answer built from a JSON body. */
function json(body: unknown, status = 200): Awaited<ReturnType<Fetcher>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/** Answer the two GitCode endpoints the flow calls after the callback. */
function gitcodeFetcher(): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (input: string) => {
    calls.push(input)
    if (input.includes('oauth/token')) {
      return json({ access_token: 'at-123', refresh_token: 'rt-456' })
    }
    if (input.includes('api/v5/user')) return json({ name: 'NPU Dev' })
    return json({}, 404)
  }) as Fetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

/** Drive the callback URL the way a browser would, once the listener is up. */
function callbackBrowser(mutate: (params: URLSearchParams) => void = () => {}): (url: string) => Promise<boolean> {
  return async (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? ''
    const params = new URLSearchParams({ code: 'the-code', state })
    mutate(params)
    // The listener is already bound before the browser is opened; a short
    // delay keeps the ordering realistic without depending on it.
    setTimeout(() => {
      void fetch(`http://127.0.0.1:3000/extension/callback?${params.toString()}`).catch(() => {})
    }, 10)
    return true
  }
}

describe('buildAuthorizeUrl', () => {
  it('carries the registered client, redirect, and the attempt nonce', () => {
    const url = new URL(buildAuthorizeUrl('nonce-1'))
    expect(url.origin).toBe('https://gitcode.com')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3000/extension/callback')
    expect(url.searchParams.get('state')).toBe('nonce-1')
    expect(url.searchParams.get('client_id')).not.toBe('')
  })
})

describe('interactiveLogin', () => {
  it('exchanges the callback code and reports the account', async () => {
    const steps: string[] = []
    const fetcher = gitcodeFetcher()
    const result = await interactiveLogin(fetcher, {
      onStep: (step, _message, detail) => { steps.push(detail === undefined ? step : `${step}`) },
      openBrowser: callbackBrowser(),
    }, 5000, undefined, 0)
    expect(result).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456', account: 'NPU Dev' })
    expect(steps).toEqual(['login-required', 'login-awaiting', 'login-exchange', 'login-ok'])
    expect(fetcher.calls.some(call => call.includes('grant_type=authorization_code'))).toBe(true)
  })

  it('keeps answering a repeated callback for a short while instead of refusing it', async () => {
    const fetcher = gitcodeFetcher()
    const callback = 'http://127.0.0.1:3000/extension/callback'
    let state = ''
    const result = await interactiveLogin(fetcher, {
      onStep: (_step, _message, detail) => {
        if (detail !== undefined && detail.startsWith('https://gitcode.com')) {
          state = new URL(detail).searchParams.get('state') ?? ''
        }
      },
      // Hand the browser the callback URL so the test can replay it later.
      openBrowser: callbackBrowser(),
    }, 5000, undefined, 2000)
    expect(result.refreshToken).toBe('rt-456')

    const callsAfterLogin = fetcher.calls.length
    // What a reload, a restored tab or a second tab does: hit the same URL again.
    const replay = await fetch(`${callback}?code=the-code&state=${state}`)
    expect(replay.status).toBe(200)
    expect(await replay.text()).toContain('已经授权成功')
    // The replay must not reach the token endpoint a second time.
    expect(fetcher.calls.length).toBe(callsAfterLogin)
  })

  it('a new sign-in takes the callback port over from the previous window', async () => {
    // The first sign-in leaves its listener up for a long window.
    await interactiveLogin(gitcodeFetcher(), {
      onStep: () => {},
      openBrowser: callbackBrowser(),
    }, 5000, undefined, 60_000)

    // A second sign-in within that window must not report the port as busy.
    const controller = new AbortController()
    const second = interactiveLogin(gitcodeFetcher(), {
      onStep: () => {},
      openBrowser: async () => {
        setTimeout(() => { controller.abort() }, 20)
        return true
      },
    }, 60_000, controller.signal, 0)
    await expect(second).rejects.toThrow('cancelled')
  })

  it('refuses a callback that does not echo this attempt nonce', async () => {
    const fetcher = gitcodeFetcher()
    await expect(interactiveLogin(fetcher, {
      onStep: () => {},
      openBrowser: callbackBrowser(params => { params.set('state', 'forged') }),
    }, 5000, undefined, 0)).rejects.toThrow('state check')
    // The forged call must never reach the token endpoint.
    expect(fetcher.calls).toEqual([])
  })

  it('fails clearly when the fixed callback port is already taken', async () => {
    const blocker = createServer(() => {})
    await new Promise<void>(resolve => { blocker.listen(3000, '127.0.0.1', resolve) })
    try {
      await expect(interactiveLogin(gitcodeFetcher(), {
        onStep: () => {},
        openBrowser: async () => true,
      }, 5000, undefined, 0)).rejects.toThrow('port 3000 is busy')
    } finally {
      await new Promise<void>(resolve => { blocker.close(() => { resolve() }) })
    }
  })

  it('frees the callback port when the caller cancels', async () => {
    const controller = new AbortController()
    const pending = interactiveLogin(gitcodeFetcher(), {
      onStep: () => {},
      openBrowser: async () => {
        // The user walked away before touching the browser.
        setTimeout(() => { controller.abort() }, 10)
        return true
      },
    }, 60_000, controller.signal, 0)
    await expect(pending).rejects.toThrow('cancelled')

    // The next attempt must be able to bind the fixed port straight away.
    const second = new AbortController()
    const retry = interactiveLogin(gitcodeFetcher(), {
      onStep: () => {},
      openBrowser: async () => true,
    }, 60_000, second.signal, 0)
    setTimeout(() => { second.abort() }, 20)
    await expect(retry).rejects.toThrow('cancelled')
  })
})
