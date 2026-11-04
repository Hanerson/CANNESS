/**
 * The connect-flow vocabulary shared by the Host routes and the settings card.
 * No Node APIs: the browser half imports this module too.
 */

/**
 * Stable identifiers for each stage the connect flow reports. The card maps
 * them to localized copy; an unknown id still renders, using the Host's own
 * message, so a Host that learns a new step keeps working with an older card.
 */
export type CannlabStep =
  | 'checking-login'
  | 'login-required'
  | 'login-awaiting'
  | 'login-exchange'
  | 'login-ok'
  | 'listing'
  | 'listing-ok'
  | 'selecting'
  | 'instance-detail'
  | 'instance-key'
  | 'instance-tunnel-url'
  | 'helper-cached'
  | 'helper-download'
  | 'helper-unpack'
  | 'helper-start'
  | 'helper-ready'
  | 'forward-hub'
  | 'forward-open'
  | 'forward-ready'
  | 'key-written'
  | 'done'
  | 'error'

/** How one step reads in the log. */
export type CannlabLevel = 'info' | 'warn' | 'error' | 'done'

/** One line of the connect log, streamed to the card as it happens. */
export interface CannlabEvent {
  /** Stable stage id, used for localized copy. */
  step: CannlabStep
  level: CannlabLevel
  /** Host-authored English sentence; always present so debugging never depends on the card. */
  message: string
  /** Extra machine detail: an HTTP status, a path, a port, an error string. */
  detail?: string
  /** Epoch milliseconds, so a stalled flow is visible in the log. */
  at: number
}

/** The connection values the card stages into its settings form. */
export interface CannlabTarget {
  host: string
  port: number
  username: string
  privateKeyPath: string
  /** Instance name, for the status line. */
  instance: string
  /** Instance id, kept so a reconnect reuses the same environment. */
  instanceId: string
}

/** Terminal frame of the stream: either the staged target or why it stopped. */
export type CannlabResult =
  | { ok: true; target: CannlabTarget }
  | { ok: false; reason: string }

/** One SSE frame on the wire. */
export type CannlabFrame =
  | { kind: 'event'; event: CannlabEvent }
  | { kind: 'result'; result: CannlabResult }

/** What `/canness/cannlab/status` answers. */
export interface CannlabStatus {
  /** Refresh token present, so a reconnect needs no browser. */
  signedIn: boolean
  /** Account shown by the last successful sign-in, when known. */
  account: string
  /** The live tunnel, when one is open. */
  tunnel: CannlabTarget | null
}

/** Why one reachability check did not connect. */
export type ProbeReason = 'empty-host' | 'invalid-port' | 'unreachable' | 'unavailable'

/** Outcome of one reachability check, as the `/canness/probe` route reports it. */
export type ProbeOutcome =
  | { ok: true }
  | { ok: false; reason: ProbeReason; detail?: string }
