/**
 * The CANNLab open API, as typed wrappers over `fetch`.
 *
 * Every response is the same envelope: `{ error_code: '0000', result }`. A
 * non-`0000` code is a business failure even on HTTP 200, so both layers are
 * checked and reported with enough text to debug without a packet capture.
 */

import {
  CANNLAB_API_BASE, CANNLAB_DEVENV_PATH, STATUS_RUNNING,
} from './constants.js'

/** The subset of `fetch` these wrappers need, so tests can pass a fake. */
export type Fetcher = (input: string, init?: { headers?: Record<string, string>, method?: string, body?: string, signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  /** Only the binary extension download needs this; the JSON endpoints use `text`. */
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** One environment as the list endpoint reports it. */
export interface CannlabInstance {
  id: string
  devstageId: string
  name: string
  /** Raw status code; `2` means running. */
  status: number
}

/** Envelope every endpoint answers with. */
interface Envelope {
  error_code?: string
  result?: unknown
}

function endpoint(path: string): string {
  return `${CANNLAB_API_BASE}${CANNLAB_DEVENV_PATH}${path}`
}

/** Read one response body as JSON without ever echoing credentials into an error. */
async function readEnvelope(response: { ok: boolean, status: number, text(): Promise<string> }, operation: string): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) throw new Error(`${operation}: HTTP ${String(response.status)}`)
  let parsed: unknown
  try {
    parsed = text.length === 0 ? null : JSON.parse(text)
  } catch {
    throw new Error(`${operation}: response was not JSON`)
  }
  const envelope = parsed as Envelope | null
  const code = envelope?.error_code
  if (code !== '0000') throw new Error(`${operation}: error_code ${typeof code === 'string' ? code : 'missing'}`)
  return envelope?.result
}

/**
 * Native call of one authenticated CANNLab endpoint.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - short-lived GitCode access token.
 * @param path - `/instances`-style path under the devenv prefix.
 * @param operation - human name used in failure text.
 * @returns the envelope's `result`.
 */
export async function callApi(fetcher: Fetcher, accessToken: string, path: string, operation: string): Promise<unknown> {
  const response = await fetcher(endpoint(path), { headers: { 'access-token': accessToken } })
  return readEnvelope(response, operation)
}

async function transition(fetcher: Fetcher, token: string, id: string, action: 'start' | 'stop', signal?: AbortSignal) {
  const response = await fetcher(endpoint(`/instances/${action}`), {
    method: 'POST',
    headers: { 'access-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ devEnvId: id, source: 'vscode' }),
    signal,
  })
  await readEnvelope(response, `CANNLab ${action}`)
}

export const startInstance = (fetcher: Fetcher, token: string, id: string, signal?: AbortSignal) =>
  transition(fetcher, token, id, 'start', signal)

export const stopInstance = (fetcher: Fetcher, token: string, id: string, signal?: AbortSignal) =>
  transition(fetcher, token, id, 'stop', signal)

/** Coerce one raw list row, tolerating missing fields rather than throwing. */
function toInstance(raw: unknown): CannlabInstance | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  if (id.length === 0) return null
  return {
    id,
    devstageId: typeof row.devstage_id === 'string' ? row.devstage_id : '',
    name: typeof row.name === 'string' ? row.name : id,
    status: typeof row.status === 'number' ? row.status : Number(row.status ?? -1),
  }
}

/**
 * List every environment in the signed-in account.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - short-lived GitCode access token.
 * @returns the parsed environments, in the order the service returned them.
 */
export async function listInstances(fetcher: Fetcher, accessToken: string): Promise<CannlabInstance[]> {
  const result = await callApi(fetcher, accessToken, '/instances?devenv_type=1', 'list instances')
  const content = (result as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return []
  return content.map(toInstance).filter((instance): instance is CannlabInstance => instance !== null)
}

/**
 * Pick the environment a connect attempt should use.
 * An explicit selector matches id, devstage id, or name; otherwise the single
 * running environment wins and anything else is an actionable failure.
 * @param instances - the account's environments.
 * @param selector - optional instance id, devstage id, or name.
 * @returns the chosen environment.
 * @throws when nothing matches, or the choice is ambiguous.
 */
export function chooseInstance(instances: CannlabInstance[], selector?: string): CannlabInstance {
  if (selector !== undefined && selector.length > 0) {
    const exact = instances.find(candidate => candidate.id === selector
      || candidate.devstageId === selector
      || candidate.name === selector)
    if (exact === undefined) throw new Error(`no environment matches "${selector}"`)
    return exact
  }
  const running = instances.filter(instance => instance.status === STATUS_RUNNING)
  if (running.length === 0) throw new Error('no CANNLab environment is running; start one in the CANNLab console first')
  if (running.length > 1) {
    throw new Error(`several environments are running (${running.map(instance => instance.name).join(', ')}); name one to connect to`)
  }
  return running[0] as CannlabInstance
}

/**
 * Fetch the detail document of one environment.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - short-lived GitCode access token.
 * @param id - instance id.
 * @returns the raw detail document.
 */
export async function getInstance(fetcher: Fetcher, accessToken: string, id: string): Promise<unknown> {
  return callApi(fetcher, accessToken, `/instances/${encodeURIComponent(id)}`, 'instance detail')
}

/**
 * Read the SSH login user out of a detail document.
 * The field lives in a JSON string nested inside the document, exactly as the
 * official extension reads it.
 * @param detail - raw detail document.
 * @returns the user name, defaulting to the CANNLab convention.
 */
export function usernameOf(detail: unknown): string {
  const content = (detail as { content?: unknown } | null)?.content
  if (typeof content !== 'string') return 'developer'
  try {
    const parsed = JSON.parse(content) as { content?: { username?: unknown } }
    const username = parsed.content?.username
    return typeof username === 'string' && username.length > 0 ? username : 'developer'
  } catch {
    return 'developer'
  }
}

/**
 * Fetch the environment's temporary SSH private key.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - short-lived GitCode access token.
 * @param id - instance id.
 * @returns the key text.
 */
export async function getPrivateKey(fetcher: Fetcher, accessToken: string, id: string): Promise<string> {
  const result = await callApi(fetcher, accessToken, `/instances/private-keys/${encodeURIComponent(id)}?source=vscode`, 'instance ssh key')
  if (typeof result !== 'string') throw new Error('instance ssh key: response carried no key')
  return Buffer.from(result, 'base64').toString('utf8')
}

/**
 * Fetch the signed tunnel URL of one environment.
 * @param fetcher - `fetch` or a test double.
 * @param accessToken - short-lived GitCode access token.
 * @param id - instance id.
 * @returns the `wss://` URL the forwarding helper dials.
 */
export async function getConnectUrl(fetcher: Fetcher, accessToken: string, id: string): Promise<string> {
  const result = await callApi(fetcher, accessToken, `/instances/connect-urls/${encodeURIComponent(id)}?source=vscode`, 'instance tunnel url')
  const url = (result as { connect_url?: unknown } | null)?.connect_url
  if (typeof url !== 'string' || url.length === 0) throw new Error('instance tunnel url: response carried no url')
  return url
}

/**
 * Rebase a signed tunnel URL onto the open API origin, over TLS.
 * The service returns a path relative to its own proxy host; the helper must
 * dial the proxy origin, not the host named in the response.
 * @param connectUrl - the URL `getConnectUrl` returned.
 * @returns the absolute `wss://` URL.
 */
export function rewriteConnectUrl(connectUrl: string): string {
  // The service normally signs an absolute URL; a relative one is resolved
  // against the proxy origin rather than thrown away.
  const source = new URL(connectUrl, CANNLAB_API_BASE)
  const target = new URL(CANNLAB_API_BASE)
  target.protocol = target.protocol === 'http:' ? 'ws:' : 'wss:'
  target.pathname = `${target.pathname.replace(/\/$/, '')}${source.pathname}`
  target.search = source.search
  target.hash = source.hash
  return target.toString()
}
