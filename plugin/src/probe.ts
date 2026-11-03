/**
 * TCP reachability for the remote eval host.
 * A successful connect means the port accepted a socket. It does not log in.
 */

import { connect as netConnect } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import {
  commandResultFromOutcome, parseProbeInput, PROBE_COMMAND, PROBE_TIMEOUT_MS,
  type ProbeOutcome,
} from './probe-contract.js'

/** Opens one TCP connection, or rejects when it cannot. */
export type TcpDial = (host: string, port: number, timeoutMs: number) => Promise<void>

/**
 * Connect once and close. The first of connect, timeout, or error settles the attempt.
 * @param host - remote host.
 * @param port - remote port.
 * @param timeoutMs - how long to wait for the handshake.
 * @returns when the socket connects.
 */
export function dialTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => { finish() })
    socket.once('timeout', () => { finish(new Error('timeout')) })
    socket.once('error', error => { finish(error) })
  })
}

/**
 * Try one TCP connect to the host and port.
 * @param host - remote host; surrounding space is ignored.
 * @param port - remote port; must be an integer from 1 to 65535.
 * @param dial - connection attempt. Tests pass a fake; production uses {@link dialTcp}.
 * @returns whether the port accepted a connection.
 */
export async function probeTcp(host: string, port: number, dial: TcpDial = dialTcp): Promise<ProbeOutcome> {
  const trimmed = host.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'empty-host' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'invalid-port' }
  try {
    await dial(trimmed, port, PROBE_TIMEOUT_MS)
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error && error.message.length > 0 ? error.message : 'connect failed'
    return { ok: false, reason: 'unreachable', detail }
  }
}

/** The slice of the commands service this registration needs. */
interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input: { hint: string }
    recordInput: boolean
    handler: (invocation: { rawInput: string }) => Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }>
  }): () => void
}

/**
 * Register `/canness-probe` when the profile has the commands service.
 * Headless profiles without that service keep working; the card then reports
 * that the check is unavailable.
 * @param ctx - the eval plugin context.
 * @param dial - TCP attempt used by the command.
 */
export function registerProbeCommand(ctx: Context, dial: TcpDial = dialTcp): void {
  const commands = ctx.get('commands') as CommandsLike | undefined
  if (commands === undefined || typeof commands.register !== 'function') return
  ctx.effect(() => commands.register({
    name: PROBE_COMMAND,
    description: 'Test whether the CANNESS remote host accepts a TCP connection.',
    input: { hint: '<host> <port>' },
    recordInput: false,
    handler: async (invocation) => {
      const parsed = parseProbeInput(invocation.rawInput)
      if ('error' in parsed) return commandResultFromOutcome({ ok: false, reason: parsed.error })
      return commandResultFromOutcome(await probeTcp(parsed.host, parsed.port, dial))
    },
  }), 'canness-eval: probe command')
}
