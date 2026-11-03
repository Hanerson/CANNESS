/**
 * Ask the host's `/canness-probe` command to open a TCP connection.
 * The browser cannot open that socket itself. The command runs on the harness
 * host, which is the machine that will later upload the test package.
 */

import { outcomeFromCommand, probeCommandLine, type ProbeOutcome } from '../probe-contract.ts'

/** One session row the card can dispatch a command to. */
interface SessionRow {
  sessionId?: string
  agentAvailable?: boolean
}

/** A carrier failure the card can quote. Assembly faults still reject. */
interface RemoteCallError {
  code?: string
  message?: string
}

/** The remote methods the reachability button uses. */
export interface ProbeRemote {
  session: {
    list(request: { cursor?: string }): Promise<{
      ok: boolean
      value?: { items?: readonly SessionRow[] }
      error?: RemoteCallError
    }>
  }
  commands: {
    execute(
      agent: string,
      line: string,
      attachments: readonly [],
    ): Promise<{
      ok: boolean
      value?: { result?: { kind?: string; text?: string } } | undefined
      error?: RemoteCallError
    }>
  }
}

/** Keep a failure sentence short enough for the status line. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 180 ? `${flat.slice(0, 177)}…` : flat
}

/**
 * A code and message the card can show.
 * @param error - a RemoteError, a thrown Error, or anything else.
 * @returns `code: message`, or `unknown` when neither is present.
 */
function failureText(error: unknown): string {
  if (typeof error === 'string') {
    const text = clip(error)
    return text.length > 0 ? text : 'unknown'
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? clip(record.code) : ''
    const message = typeof record.message === 'string' ? clip(record.message) : ''
    if (code.length > 0 && message.length > 0) return clip(`${code}: ${message}`)
    if (message.length > 0) return message
    if (code.length > 0) return code
  }
  return 'unknown'
}

/** An unavailable outcome that names which call failed. */
function unavailable(scope: 'list' | 'execute', error: unknown): ProbeOutcome {
  return { ok: false, reason: 'unavailable', detail: `${scope}:${failureText(error)}` }
}

/**
 * Run the probe through a live session.
 * No session means the host has nowhere to execute the command, so the card
 * says so instead of creating one.
 * @param remote - session list and command execute.
 * @param host - draft host.
 * @param port - draft port.
 * @returns the command's outcome, or why it could not be sent.
 */
export async function probeThroughCaller(remote: ProbeRemote, host: string, port: number): Promise<ProbeOutcome> {
  let sessionId: string | undefined
  try {
    const listed = await remote.session.list({})
    if (!listed.ok) return unavailable('list', listed.error)
    sessionId = listed.value?.items?.find(item => item.agentAvailable === true && item.sessionId !== undefined)?.sessionId
  } catch (error: unknown) {
    return unavailable('list', error)
  }
  if (sessionId === undefined) return { ok: false, reason: 'no-session' }
  try {
    const executed = await remote.commands.execute(sessionId, probeCommandLine(host, port), [])
    if (!executed.ok) return unavailable('execute', executed.error)
    const result = executed.value?.result
    if (executed.value === undefined || result === undefined) return { ok: false, reason: 'unavailable', detail: 'command-missing' }
    if (result.kind === undefined) return { ok: false, reason: 'unavailable', detail: 'result-missing' }
    return outcomeFromCommand({ kind: result.kind, text: result.text })
  } catch (error: unknown) {
    return unavailable('execute', error)
  }
}
