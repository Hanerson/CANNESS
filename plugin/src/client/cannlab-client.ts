/**
 * The browser half of the remote-connection routes.
 *
 * Both of these are `fetch` calls to the same origin the page is served from,
 * which is why they work with no open session: the Host process answers them
 * directly. The connect route streams server-sent events, so the card can show
 * each stage while the flow is still running.
 */

import type {
  CannlabEvent, CannlabFrame, CannlabResult, CannlabStatus, ProbeOutcome,
} from '../cannlab/types.js'

/** Paths, mirrored from the Host half. */
const PROBE_ROUTE = 'canness/probe'
const CONNECT_ROUTE = 'canness/cannlab/connect'
const STATUS_ROUTE = 'canness/cannlab/status'
const DISCONNECT_ROUTE = 'canness/cannlab/disconnect'

/** Keep a failure sentence short enough for a status line. */
function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat
}

/**
 * Ask the Host for one TCP reachability check.
 * @param host - host from the form.
 * @param port - port from the form.
 * @returns the outcome the card shows.
 */
export async function probeViaHost(host: string, port: number): Promise<ProbeOutcome> {
  let response: Response
  try {
    response = await fetch(PROBE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, port }),
    })
  } catch (error: unknown) {
    return { ok: false, reason: 'unavailable', detail: `host unreachable: ${clip(error instanceof Error ? error.message : 'fetch failed')}` }
  }
  if (!response.ok) return { ok: false, reason: 'unavailable', detail: `HTTP ${String(response.status)}` }
  try {
    const payload = await response.json() as ProbeOutcome
    return payload
  } catch {
    return { ok: false, reason: 'unavailable', detail: 'the host returned no JSON' }
  }
}

/**
 * Read the current tube state: signed in, and the live tunnel if one is open.
 * @returns the status, or null when the Host half is not mounted.
 */
export async function readStatus(): Promise<CannlabStatus | null> {
  try {
    const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return await response.json() as CannlabStatus
  } catch {
    return null
  }
}

/**
 * Close the live tunnel, if the Host holds one.
 * @returns true when the Host confirmed the call.
 */
export async function disconnect(): Promise<boolean> {
  try {
    const response = await fetch(DISCONNECT_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return response.ok
  } catch {
    return false
  }
}

/** Split one SSE payload block into its `data:` payloads. */
function framesOf(block: string): string[] {
  const out: string[] = []
  for (const line of block.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload.length > 0) out.push(payload)
  }
  return out
}

/**
 * Run one connect attempt and report every stage as the Host publishes it.
 * @param instance - optional environment name or id; empty lets the Host choose.
 * @param onEvent - called once per stage.
 * @param signal - cancellation for the request.
 * @returns the staged target, or why the flow stopped.
 */
export async function connectCannlab(
  instance: string,
  onEvent: (event: CannlabEvent) => void,
  signal: AbortSignal,
): Promise<CannlabResult> {
  let response: Response
  try {
    response = await fetch(CONNECT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ instance }),
      signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: `the host could not start the flow: ${clip(error instanceof Error ? error.message : 'fetch failed')}` }
  }
  if (!response.ok) return { ok: false, reason: `the host refused the flow: HTTP ${String(response.status)}` }
  if (response.body === null) return { ok: false, reason: 'the host sent no event stream' }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: CannlabResult = { ok: false, reason: 'the host closed the stream before reporting a result' }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const payload of framesOf(block)) {
          let frame: CannlabFrame
          try {
            frame = JSON.parse(payload) as CannlabFrame
          } catch {
            continue
          }
          if (frame.kind === 'event') onEvent(frame.event)
          else if (frame.kind === 'result') result = frame.result
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error: unknown) {
    if (signal.aborted) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: `the event stream broke: ${clip(error instanceof Error ? error.message : 'read failed')}` }
  } finally {
    reader.releaseLock()
  }
  return result
}
