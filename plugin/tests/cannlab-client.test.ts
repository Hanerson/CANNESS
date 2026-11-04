/** The browser half's event-stream reader and reachability call, over a stubbed fetch. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectCannlab, disconnect, probeViaHost, readStatus } from '../src/client/cannlab-client.js'

/** Build a Response-like object whose body streams the given text chunks. */
function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

afterEach(() => { vi.unstubAllGlobals() })

describe('connectCannlab', () => {
  it('turns server-sent frames into events and a final result', async () => {
    const event = { step: 'listing', level: 'info', message: 'Listing.', at: 1 }
    const target = { host: '127.0.0.1', port: 20022, username: 'developer', privateKeyPath: '/k', instance: 'DevHW', instanceId: 'a' }
    // Frames are split across chunks on purpose: the reader must buffer.
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([
      `data: ${JSON.stringify({ kind: 'event', event })}\n\ndata: {"kind":"res`,
      `ult","result":{"ok":true,"target":${JSON.stringify(target)}}}\n\n`,
    ])))
    const seen: string[] = []
    const result = await connectCannlab('', item => { seen.push(item.step) }, new AbortController().signal)
    expect(seen).toEqual(['listing'])
    expect(result).toEqual({ ok: true, target })
  })

  it('reports a failed result from the host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([
      'data: {"kind":"result","result":{"ok":false,"reason":"no environment"}}\n\n',
    ])))
    await expect(connectCannlab('', () => {}, new AbortController().signal))
      .resolves.toEqual({ ok: false, reason: 'no environment' })
  })

  it('reports a closed stream that never carried a result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamedResponse([])))
    const result = await connectCannlab('', () => {}, new AbortController().signal)
    expect(result).toEqual({ ok: false, reason: 'the host closed the stream before reporting a result' })
  })

  it('reports a refused request with its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, body: null }) as unknown as Response))
    const result = await connectCannlab('', () => {}, new AbortController().signal)
    expect(result).toEqual({ ok: false, reason: 'the host refused the flow: HTTP 401' })
  })
})

describe('probeViaHost', () => {
  it('passes the host verdict through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' }),
    }) as unknown as Response))
    await expect(probeViaHost('127.0.0.1', 20022))
      .resolves.toEqual({ ok: false, reason: 'unreachable', detail: 'ECONNREFUSED' })
  })

  it('reports a transport failure as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const outcome = await probeViaHost('127.0.0.1', 22)
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ reason: 'unavailable' })
  })
})

describe('status and disconnect', () => {
  it('reads the host status', async () => {
    const status = { signedIn: true, account: 'me', tunnel: null }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => status }) as unknown as Response))
    await expect(readStatus()).resolves.toEqual(status)
  })

  it('reads null when the host half is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response))
    await expect(readStatus()).resolves.toBeNull()
  })

  it('confirms a disconnect only on a successful answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response))
    await expect(disconnect()).resolves.toBe(true)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(disconnect()).resolves.toBe(false)
  })
})
