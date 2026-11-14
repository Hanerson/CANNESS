/** The CANNLab open API wrappers: envelope handling, instance selection, tunnel URL rebasing. */

import { describe, expect, it } from 'vitest'
import {
  chooseInstance, getPrivateKey, listInstances, rewriteConnectUrl, startInstance, stopInstance, usernameOf,
  type Fetcher,
} from '../src/cannlab/api.js'

/** One fetch answer built from a JSON body. */
function json(body: unknown, status = 200): Awaited<ReturnType<Fetcher>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/** A fetcher that records calls and answers from a queue. */
function fakeFetcher(...answers: Array<Awaited<ReturnType<Fetcher>>>): Fetcher & { calls: string[] } {
  const calls: string[] = []
  const fetcher = (async (input: string) => {
    calls.push(input)
    const next = answers.shift()
    if (next === undefined) throw new Error(`unexpected call ${input}`)
    return next
  }) as Fetcher & { calls: string[] }
  fetcher.calls = calls
  return fetcher
}

describe('listInstances', () => {
  it('parses the content array and keeps the documented fields', async () => {
    const fetcher = fakeFetcher(json({
      error_code: '0000',
      result: { content: [{ id: 'a', devstage_id: 'd1', name: 'DevHW', status: 2 }] },
    }))
    const instances = await listInstances(fetcher, 'token')
    expect(instances).toEqual([{ id: 'a', devstageId: 'd1', name: 'DevHW', status: 2 }])
    expect(fetcher.calls[0]).toContain('/instances?devenv_type=1')
  })

  it('drops rows without an id instead of failing the whole listing', async () => {
    const fetcher = fakeFetcher(json({ error_code: '0000', result: { content: [{ name: 'x' }, { id: 'b' }] } }))
    const instances = await listInstances(fetcher, 'token')
    expect(instances.map(instance => instance.id)).toEqual(['b'])
  })

  it('reports a business error code even on HTTP 200', async () => {
    const fetcher = fakeFetcher(json({ error_code: '1401', result: null }))
    await expect(listInstances(fetcher, 'token')).rejects.toThrow('error_code 1401')
  })

  it('reports the HTTP status when the call itself fails', async () => {
    const fetcher = fakeFetcher(json({}, 500))
    await expect(listInstances(fetcher, 'token')).rejects.toThrow('HTTP 500')
  })
})

it('uses the Dev Space lifecycle actions for the selected instance', async () => {
  const calls: Array<[string, Parameters<Fetcher>[1]]> = []
  const fetcher: Fetcher = async (url, init) => {
    calls.push([url, init])
    return json({ error_code: '0000' })
  }
  await startInstance(fetcher, 'token', 'instance-id')
  await stopInstance(fetcher, 'token', 'instance-id')
  expect(calls.map(([url]) => new URL(url).pathname.split('/').at(-1))).toEqual(['start', 'stop'])
  for (const [, init] of calls) {
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init!.body!)).toEqual({ devEnvId: 'instance-id', source: 'vscode' })
  }
})

describe('chooseInstance', () => {
  const running = { id: 'a', devstageId: 'd1', name: 'DevHW', status: 2 }

  it('takes the only running environment', () => {
    expect(chooseInstance([{ id: 'b', devstageId: 'd2', name: 'Off', status: 4 }, running])).toBe(running)
  })

  it('matches an explicit selector by id, devstage id, or name', () => {
    expect(chooseInstance([running], 'a')).toBe(running)
    expect(chooseInstance([running], 'd1')).toBe(running)
    expect(chooseInstance([running], 'DevHW')).toBe(running)
  })

  it('refuses when nothing is running', () => {
    expect(() => chooseInstance([{ id: 'b', devstageId: 'd2', name: 'Off', status: 4 }]))
      .toThrow('no CANNLab environment is running')
  })

  it('names the running environments when the choice is ambiguous', () => {
    expect(() => chooseInstance([running, { id: 'c', devstageId: 'd3', name: 'Other', status: 2 }]))
      .toThrow('several environments are running (DevHW, Other)')
  })

  it('names the selector that matched nothing', () => {
    expect(() => chooseInstance([running], 'nope')).toThrow('no environment matches "nope"')
  })
})

describe('usernameOf', () => {
  it('reads the nested JSON string the service returns', () => {
    const detail = { content: JSON.stringify({ content: { username: 'developer' } }) }
    expect(usernameOf(detail)).toBe('developer')
  })

  it('falls back to the CANNLab convention when the document is unusable', () => {
    expect(usernameOf(null)).toBe('developer')
    expect(usernameOf({ content: 'not json' })).toBe('developer')
    expect(usernameOf({ content: JSON.stringify({ content: {} }) })).toBe('developer')
  })
})

describe('getPrivateKey', () => {
  it('decodes the base64 key body', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n'
    const fetcher = fakeFetcher(json({ error_code: '0000', result: Buffer.from(key).toString('base64') }))
    await expect(getPrivateKey(fetcher, 'token', 'a')).resolves.toBe(key)
    expect(fetcher.calls[0]).toContain('/instances/private-keys/a?source=vscode')
  })

  it('refuses a non-string payload', async () => {
    const fetcher = fakeFetcher(json({ error_code: '0000', result: { key: 'x' } }))
    await expect(getPrivateKey(fetcher, 'token', 'a')).rejects.toThrow('carried no key')
  })
})

describe('rewriteConnectUrl', () => {
  it('rebases the signed path onto the open API origin over TLS', () => {
    const url = rewriteConnectUrl('wss://dev.gitcode.com/proxy/abc?token=1#frag')
    expect(url).toBe('wss://dev.gitcode.com/api/v1/proxy/vscode/proxy/abc?token=1#frag')
  })

  it('keeps a relative path and switches to wss for a plain http base', () => {
    expect(rewriteConnectUrl('/tunnel/x')).toBe('wss://dev.gitcode.com/api/v1/proxy/vscode/tunnel/x')
  })
})
