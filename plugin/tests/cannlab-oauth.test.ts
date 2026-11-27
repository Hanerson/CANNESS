/**
 * The OAuth callback server, exercised against a real loopback listener.
 * The browser is simulated by calling the exact callback URL GitCode would,
 * which is the only way to prove the state check and the exchange wiring
 * without an interactive sign-in.
 */

import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl, interactiveLogin } from '../src/cannlab/oauth.js'
import { connect } from '../src/cannlab/connect.js'
import type { Fetcher } from '../src/cannlab/api.js'
import type { TokenStore } from '../src/cannlab/tokens.js'

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
    }, 5000)
    expect(result).toEqual({ accessToken: 'at-123', refreshToken: 'rt-456', account: 'NPU Dev' })
    expect(steps).toEqual(['login-required', 'login-awaiting', 'login-exchange', 'login-ok'])
    expect(fetcher.calls.some(call => call.includes('grant_type=authorization_code'))).toBe(true)
  })

  it('refuses a callback that does not echo this attempt nonce', async () => {
    const fetcher = gitcodeFetcher()
    await expect(interactiveLogin(fetcher, {
      onStep: () => {},
      openBrowser: callbackBrowser(params => { params.set('state', 'forged') }),
    }, 5000)).rejects.toThrow('state check')
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
      }, 5000)).rejects.toThrow('port 3000 is busy')
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
    }, 60_000, controller.signal)
    await expect(pending).rejects.toThrow('cancelled')

    // The next attempt must be able to bind the fixed port straight away.
    const second = new AbortController()
    const retry = interactiveLogin(gitcodeFetcher(), {
      onStep: () => {},
      openBrowser: async () => true,
    }, 60_000, second.signal)
    setTimeout(() => { second.abort() }, 20)
    await expect(retry).rejects.toThrow('cancelled')
  })
})

function storedSession(): TokenStore {
  let refreshToken: string | undefined = 'saved-token'
  return {
    read: async () => refreshToken,
    write: async value => { refreshToken = value },
    clear: async () => { refreshToken = undefined },
    describe: () => 'test credential',
  }
}

describe('stored OAuth session', () => {
  it('persists the rotated refresh token before proceeding to instance lookup', async () => {
    const tokenStore = storedSession()
    const openBrowser = vi.fn(async () => false)
    await expect(connect({
      tokenStore, logPath: null, keyDir: '', openBrowser, onEvent: () => {},
      fetcher: async (input, options) => {
        const url = new URL(input)
        if (url.searchParams.get('grant_type') === 'refresh_token') {
          expect(url.searchParams.get('refresh_token')).toBe('saved-token')
          return json({ access_token: 'live-access-token', refresh_token: 'rotated-token' })
        }
        expect(url.pathname.endsWith('/instances')).toBe(true)
        expect(options?.headers).toMatchObject({ 'access-token': 'live-access-token' })
        expect(await tokenStore.read()).toBe('rotated-token')
        return json({ error_code: '1401' })
      },
    })).rejects.toThrow('list instances: error_code 1401')
    expect(openBrowser).not.toHaveBeenCalled()
  })

  it.each([
    ['a failed refresh', json({ error: 'invalid_grant' }, 401)],
    ['an empty access token', json({ access_token: '', refresh_token: 'unusable-rotation' })],
  ] as const)('requires sign-in after %s', async (_name, refreshResponse) => {
    const tokenStore = storedSession()
    const controller = new AbortController()
    const steps: string[] = []
    const fetcher = vi.fn<Fetcher>(async () => refreshResponse)
    const openBrowser = vi.fn(async () => {
      controller.abort()
      return true
    })
    await expect(connect({
      tokenStore, logPath: null, keyDir: '', signal: controller.signal,
      fetcher, openBrowser, onEvent: event => { steps.push(event.step) },
    })).rejects.toThrow('cancelled')
    expect(openBrowser).toHaveBeenCalledOnce()
    expect(steps).toContain('login-required')
    expect(steps).not.toContain('login-ok')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(await tokenStore.read()).toBe('saved-token')
  })
})
