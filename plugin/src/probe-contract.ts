/** Shared words for the settings-card reachability check. No Node APIs. */

/** Slash command the host registers and the card invokes. */
export const PROBE_COMMAND = 'canness-probe'

/** How long a TCP connect may wait before it counts as unreachable. */
export const PROBE_TIMEOUT_MS = 5_000

/** Why a reachability check did not connect. */
export type ProbeReason = 'empty-host' | 'invalid-port' | 'unreachable' | 'no-session' | 'unavailable'

/** Outcome of one reachability check. */
export type ProbeOutcome =
  | { ok: true }
  | { ok: false; reason: ProbeReason; detail?: string }

/** Command result text for a successful TCP connect. */
export const PROBE_REACHABLE = 'reachable'

/**
 * Parse the text after `/canness-probe`.
 * The last token is the port; everything before it is the host.
 * @param raw - command tail, which may include the leading separator space.
 * @returns a target, or which input problem to report.
 */
export function parseProbeInput(raw: string): { host: string; port: number } | { error: 'empty-host' | 'invalid-port' } {
  const parts = raw.trim().split(/\s+/).filter(part => part.length > 0)
  if (parts.length === 0) return { error: 'empty-host' }
  const portText = parts[parts.length - 1] ?? ''
  const host = parts.slice(0, -1).join(' ')
  if (host.length === 0) return { error: 'empty-host' }
  if (!/^\d+$/.test(portText)) return { error: 'invalid-port' }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'invalid-port' }
  return { host, port }
}

/**
 * Encode a probe outcome as the command result the card can read back.
 * @param outcome - what the TCP check decided.
 * @returns the command result text.
 */
export function commandResultFromOutcome(outcome: ProbeOutcome): { kind: 'success'; text: string } | { kind: 'error'; text: string } {
  if (outcome.ok) return { kind: 'success', text: PROBE_REACHABLE }
  if (outcome.reason === 'unreachable' && outcome.detail !== undefined && outcome.detail.length > 0) {
    return { kind: 'error', text: `unreachable:${outcome.detail}` }
  }
  return { kind: 'error', text: outcome.reason }
}

/**
 * Read the command result back into a probe outcome.
 * @param result - settled command result, or undefined when the command did not run.
 * @returns the outcome the card should show.
 */
export function outcomeFromCommand(result: { kind: string; text?: string } | undefined): ProbeOutcome {
  if (result === undefined) return { ok: false, reason: 'unavailable' }
  if (result.kind === 'success') return { ok: true }
  const text = result.text ?? ''
  if (text === 'empty-host' || text === 'invalid-port' || text === 'no-session' || text === 'unavailable') {
    return { ok: false, reason: text }
  }
  if (text === 'unreachable') return { ok: false, reason: 'unreachable' }
  if (text.startsWith('unreachable:')) return { ok: false, reason: 'unreachable', detail: text.slice('unreachable:'.length) }
  return { ok: false, reason: 'unreachable', detail: text }
}
