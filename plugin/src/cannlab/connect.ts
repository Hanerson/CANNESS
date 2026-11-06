/**
 * The connect flow: sign in, find the environment, open the tunnel, stage the
 * values the evaluation transport needs.
 *
 * Every stage reports to one callback before it starts work, so the card can
 * show where a stalled or failed attempt stopped — the reason this flow is
 * verbose instead of terse.
 */

import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import {
  chooseInstance, getConnectUrl, getInstance, getPrivateKey, listInstances, rewriteConnectUrl, usernameOf,
  type Fetcher,
} from './api.js'
import { interactiveLogin, refreshAccessToken } from './oauth.js'
import {
  createForwardHub, defaultCacheRoot, deleteForwardHub, ensureHelperRunning, ensureUnpacked, helperPaths,
  helperRequest, startForward, startHelperKeepalive,
} from './helper.js'
import { LOOPBACK, SSH_REMOTE_PORT, STATUS_RUNNING } from './constants.js'
import type { CannlabEvent, CannlabStep, CannlabTarget } from './types.js'
import { dshHome, type TokenStore } from './tokens.js'
import { attemptLogPath, startAttemptLog } from './connect-log.js'

/** Everything one connect attempt needs from its caller. */
export interface ConnectOptions {
  fetcher: Fetcher
  tokenStore: TokenStore
  /** Cache directory for the downloaded extension; empty falls back to the Harness home. */
  cacheRoot?: string
  /** Directory the temporary SSH key is written under. */
  keyDir: string
  /** Where to keep the durable copy of this attempt; null disables it. */
  logPath?: string | null
  /** Environment name, id, or devstage id; empty picks the only running one. */
  selector?: string
  /** Cancels the browser wait, which frees the fixed callback port immediately. */
  signal?: AbortSignal
  /** One line of progress, as it happens. */
  onEvent: (event: CannlabEvent) => void
  /** Open the authorization page; false means the caller must show the URL itself. */
  openBrowser: (url: string) => Promise<boolean>
}

/**
 * A path option, or null when the value cannot possibly name a path.
 * Options arrive from a config object that is not guaranteed to hold strings,
 * so this is the last gate before any value reaches `node:path`.
 * @param value - the option as received.
 * @returns the path, or null.
 */
function pathOption(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** A live tunnel plus how to tear it down. */
export interface OpenTunnel {
  target: CannlabTarget
  devenvId: string
  helperPort: number
  /** GitCode account that authorized this tunnel, when a browser sign-in produced it. */
  account: string
  /** Stop heartbeats and close the hub. Safe to call twice. */
  stop: () => Promise<void>
}

/** One emitter that stamps every event with the current time and records it. */
function emitter(
  onEvent: (event: CannlabEvent) => void,
  log?: { append: (event: CannlabEvent) => void },
) {
  return (step: CannlabStep, level: CannlabEvent['level'], message: string, detail?: string): void => {
    const event: CannlabEvent = {
      step,
      level,
      message,
      ...detail === undefined ? {} : { detail },
      at: Date.now(),
    }
    log?.append(event)
    onEvent(event)
  }
}

/** A written temporary key and whether its permissions could be narrowed. */
export interface WrittenKey {
  /** Absolute path of the key file. */
  path: string
  /**
   * True when only the current account can read the file. False means the file
   * exists and `ssh2` can still use it, but an external `ssh`/`scp` may refuse
   * it as "too open".
   */
  restricted: boolean
}

/** Narrows one key file's permissions; returns whether it succeeded. */
export type KeyRestrictor = (path: string) => boolean

/**
 * Restrict a key file to the current account.
 *
 * POSIX is `0600`. Windows ignores that mode entirely: the file keeps the
 * inherited ACL of its directory, which typically includes a group every
 * process on the machine belongs to, and OpenSSH then refuses the key as
 * "UNPROTECTED PRIVATE KEY FILE". There the ACL is rewritten instead — no
 * inheritance, one read grant for the signed-in user.
 * @param path - absolute key path.
 * @returns whether the file is now readable only by this account.
 */
export function restrictKeyToOwner(path: string): boolean {
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
      return true
    } catch {
      return false
    }
  }
  const account = process.env.USERNAME ?? userInfo().username
  if (account.length === 0) return false
  try {
    const inherit = spawnSync('icacls', [path, '/inheritance:r'], { windowsHide: true })
    if (inherit.status !== 0) return false
    // `:R` keeps the key readable by the owner while removing every inherited
    // principal, which is exactly what OpenSSH checks for.
    const grant = spawnSync('icacls', [path, '/grant:r', `${account}:(R)`], { windowsHide: true })
    return grant.status === 0
  } catch {
    return false
  }
}

/**
 * Write the temporary private key where the SSH transport can read it.
 * The path is stable per environment so a reconnect overwrites the old one
 * instead of leaving keys behind.
 * @param keyDir - root directory for keys.
 * @param instanceId - environment the key belongs to.
 * @param key - key text from the API.
 * @param restrict - permission narrowing; a test passes its own.
 * @returns the written key and whether its permissions are narrow.
 */
export function writePrivateKey(
  keyDir: string,
  instanceId: string,
  key: string,
  restrict: KeyRestrictor = restrictKeyToOwner,
): WrittenKey {
  const dir = join(keyDir, instanceId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `id_${randomBytes(3).toString('hex')}`)
  writeFileSync(path, key.endsWith('\n') ? key : `${key}\n`, { encoding: 'utf8', mode: 0o600 })
  return { path, restricted: restrict(path) }
}

/**
 * Exchange the stored refresh token for a live access token.
 * @param fetcher - `fetch` or a test double.
 * @param tokenStore - where the refresh token lives.
 * @param emit - progress sink.
 * @returns a live access token, or undefined when the caller must sign in.
 */
async function silentAccessToken(
  fetcher: Fetcher,
  tokenStore: TokenStore,
  emit: ReturnType<typeof emitter>,
): Promise<string | undefined> {
  const refreshToken = await tokenStore.read()
  if (refreshToken === undefined) {
    emit('checking-login', 'info', 'No saved GitCode session on this machine.')
    return undefined
  }
  emit('checking-login', 'info', 'Found a saved GitCode session; refreshing it.', tokenStore.describe())
  try {
    const token = await refreshAccessToken(fetcher, refreshToken)
    const accessToken = token.access_token
    if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
    const rotated = token.refresh_token
    if (typeof rotated === 'string' && rotated.length > 0 && rotated !== refreshToken) {
      await tokenStore.write(rotated)
    }
    emit('login-ok', 'info', 'GitCode session refreshed without a browser.')
    return accessToken
  } catch (error) {
    emit('checking-login', 'warn', 'The saved session could not be refreshed; a browser sign-in is needed.',
      error instanceof Error ? error.message : 'refresh failed')
    return undefined
  }
}

/** The tunnel that is currently open, if any, so the routes can report status. */
let openTunnel: OpenTunnel | null = null

/** @returns the live tunnel without changing it. */
export function currentTunnel(): OpenTunnel | null {
  return openTunnel
}

/** Whether a configured SSH endpoint is the live CANNLab forward, not a real host. */
export function usesCurrentTunnel(host: string, port: number): boolean {
  const tunnel = openTunnel
  return tunnel !== null && tunnel.target.host === host && tunnel.target.port === port
}

export type TunnelHealth = 'up' | 'down' | 'none'

/**
 * Probe the forwarding helper behind the live tunnel.
 *
 * `none` means no tunnel is open (a normal direct SSH host); `down` means the
 * configured endpoint belongs to a tunnel whose helper no longer answers. The
 * distinction matters: `down` is a reconnect-in-the-card problem, not an SSH
 * authentication problem.
 * @returns the tunnel state.
 */
export async function tunnelHealth(): Promise<TunnelHealth> {
  const tunnel = openTunnel
  if (tunnel === null) return 'none'
  try {
    await helperRequest(tunnel.helperPort, '/heartbeat')
    return 'up'
  } catch {
    return 'down'
  }
}

/**
 * Renew the helper's idle timer once, before a long evaluation.
 * @returns whether the heartbeat succeeded.
 */
export async function renewTunnel(): Promise<boolean> {
  const tunnel = openTunnel
  if (tunnel === null) return false
  try {
    await helperRequest(tunnel.helperPort, '/heartbeat')
    return true
  } catch {
    return false
  }
}

/**
 * Close the live tunnel, if one is open.
 * @returns the tunnel that was closed, or null when none was.
 */
export async function closeTunnel(): Promise<OpenTunnel | null> {
  const tunnel = openTunnel
  if (tunnel === null) return null
  openTunnel = null
  await tunnel.stop()
  return tunnel
}

/**
 * Run the whole connect flow.
 * @param options - dependencies, progress sink, cancellation, and instance selector.
 * @returns the open tunnel, ready for the settings card to stage.
 */
export async function connect(options: ConnectOptions): Promise<OpenTunnel> {
  // One sentinel, not two: `null` disables the trace and everything that is
  // not a usable path falls back to the default. A config value that is not a
  // string must never reach `node:path` — that is what once failed an attempt
  // before its first log line could be written.
  const logPath = pathOption(options.logPath) ?? (options.logPath === null ? null : attemptLogPath(dshHome()))
  const log = logPath === null ? undefined : startAttemptLog(logPath)
  const emit = emitter(options.onEvent, log)
  try {
    return await connectFlow(options, emit)
  } catch (error) {
    // The failure itself belongs in the same trace as the stages: a log that
    // stops at the last successful step is the one thing worse than no log.
    const message = error instanceof Error ? error.message : 'connect failed'
    if (message === 'cancelled') {
      emit('error', 'warn', 'Connect cancelled before the tunnel was open.', message)
    } else {
      emit('error', 'error', 'Connect failed.', message)
    }
    throw error
  }
}

/**
 * The stages themselves.
 * @param options - everything {@link connect} received.
 * @param emit - the stage emitter, which also records the durable trace.
 * @returns the open tunnel.
 */
async function connectFlow(options: ConnectOptions, emit: ReturnType<typeof emitter>): Promise<OpenTunnel> {
  const cacheRoot = pathOption(options.cacheRoot) ?? defaultCacheRoot()
  const keyDir = pathOption(options.keyDir) ?? join(dshHome(), 'canness', 'cannlab')
  const selector = typeof options.selector === 'string' ? options.selector : ''
  const checkCancelled = (): void => {
    if (options.signal?.aborted === true) throw new Error('cancelled')
  }

  if (currentTunnel() !== null) {
    emit('forward-open', 'info', 'Replacing the tunnel that was already open.')
    await closeTunnel()
  }

  let accessToken = await silentAccessToken(options.fetcher, options.tokenStore, emit)
  let account = ''
  if (accessToken === undefined) {
    const login = await interactiveLogin(options.fetcher, {
      onStep: (step, message, detail) => { emit(step, 'info', message, detail) },
      openBrowser: options.openBrowser,
    }, undefined, options.signal)
    accessToken = login.accessToken
    account = login.account
    if (login.refreshToken !== undefined) {
      try {
        await options.tokenStore.write(login.refreshToken)
        emit('login-ok', 'info', 'Refresh token saved for next time.', options.tokenStore.describe())
      } catch (error) {
        emit('login-ok', 'warn', 'Signed in, but the refresh token could not be saved; the next connect asks again.',
          error instanceof Error ? error.message : 'store failed')
      }
    }
  }
  checkCancelled()

  emit('listing', 'info', 'Listing the CANNLab environments in this account.')
  const instances = await listInstances(options.fetcher, accessToken)
  emit('listing-ok', instances.length === 0 ? 'warn' : 'info',
    `Found ${String(instances.length)} environment(s).`,
    instances.map(instance => `${instance.name} [status ${String(instance.status)}]`).join(', '))
  const instance = chooseInstance(instances, selector)
  emit('selecting', 'info', `Using environment "${instance.name}".`, `id ${instance.id} · devstage ${instance.devstageId}`)
  if (instance.status !== STATUS_RUNNING) {
    throw new Error(`environment "${instance.name}" is not running (status ${String(instance.status)}); start it in the CANNLab console`)
  }
  if (instance.devstageId.length === 0) throw new Error('the environment carries no devstage id, so no tunnel can address it')

  emit('instance-detail', 'info', 'Reading the instance detail for its SSH user.')
  const detail = await getInstance(options.fetcher, accessToken, instance.id).catch((error: unknown) => {
    // The detail document only supplies the login name and has a documented
    // default, so a failure here must not end the flow.
    emit('instance-detail', 'warn', 'Could not read the instance detail; assuming the default SSH user.',
      error instanceof Error ? error.message : 'detail failed')
    return null
  })
  const username = usernameOf(detail)
  emit('instance-detail', 'info', `SSH user is "${username}".`)

  emit('instance-key', 'info', 'Fetching the temporary SSH private key.')
  const privateKey = await getPrivateKey(options.fetcher, accessToken, instance.id)
  emit('instance-key', 'info', 'Temporary key received.', `${String(privateKey.length)} bytes`)

  emit('instance-tunnel-url', 'info', 'Fetching the signed tunnel URL.')
  const connectUrl = rewriteConnectUrl(await getConnectUrl(options.fetcher, accessToken, instance.id))
  emit('instance-tunnel-url', 'info', 'Tunnel URL ready.', new URL(connectUrl).host)

  const paths = helperPaths(cacheRoot)
  const helper = await ensureUnpacked(options.fetcher, paths, (step, message, detailEm) => { emit(step, 'info', message, detailEm) })
  const running = await ensureHelperRunning(helper, (step, message, detailEm) => { emit(step, 'info', message, detailEm) })

  // The helper dials the signed WebSocket while creating the hub, so both
  // steps belong to one recoverable unit: a failure must not leave a hub
  // registered or a heartbeat timer running, or the next attempt meets
  // leftovers from this one.
  let stopKeepalive: (() => void) | undefined
  let localPort: number
  try {
    emit('forward-hub', 'info', 'Creating the forward hub for this environment.')
    await createForwardHub(running.port, instance.devstageId, connectUrl)
    emit('forward-open', 'info', `Mapping remote port ${String(SSH_REMOTE_PORT)} to a local loopback port.`)
    localPort = await startForward(running.port, instance.devstageId, SSH_REMOTE_PORT)
    stopKeepalive = startHelperKeepalive(running.port)
  } catch (error) {
    stopKeepalive?.()
    await deleteForwardHub(running.port, instance.devstageId)
    const message = error instanceof Error ? error.message : 'tunnel failed'
    emit('forward-hub', 'error',
      'The forwarding helper could not open the tunnel. An expired signed URL and an environment the console stopped both look like this.',
      message)
    throw error
  }
  emit('forward-ready', 'info', 'Tunnel is open.', `${LOOPBACK}:${String(localPort)} -> remote ${String(SSH_REMOTE_PORT)}`)

  const written = writePrivateKey(keyDir, instance.id, privateKey)
  if (written.restricted) {
    emit('key-written', 'info', 'Temporary SSH key written.', written.path)
  } else {
    // The tunnel still works: `ssh2` reads the file in-process and does not
    // check ACLs. Only an external ssh/scp run by the user would be refused.
    emit('key-written', 'warn',
      'Temporary SSH key written, but its permissions could not be narrowed to this account; an external ssh or scp may refuse it as too open.',
      written.path)
  }

  const target: CannlabTarget = {
    host: LOOPBACK,
    port: localPort,
    username,
    privateKeyPath: written.path,
    instance: instance.name,
    instanceId: instance.id,
  }
  let stopped = false
  openTunnel = {
    target,
    devenvId: instance.devstageId,
    helperPort: running.port,
    account,
    stop: async () => {
      if (stopped) return
      stopped = true
      stopKeepalive?.()
      await deleteForwardHub(running.port, instance.devstageId)
    },
  }
  emit('done', 'done', `Connected to "${instance.name}".`,
    `${username}@${LOOPBACK}:${String(localPort)} via ${target.privateKeyPath}`)
  return openTunnel
}
