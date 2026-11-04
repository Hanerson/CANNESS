/**
 * The official AtomGit Dev Space port-forwarding helper.
 *
 * CANNLab exposes no inbound SSH at all: the only path to an environment is the
 * extension's own WebSocket forwarder, which maps a remote port onto a local
 * loopback port. We do not reimplement that protocol. We download the
 * extension's VSIX from the marketplace, unpack it, run the standalone helper
 * it ships with, and drive it over its local HTTP API — exactly what the
 * `npussh` client does.
 *
 * Surface used here:
 *   GET  /heartbeat
 *   POST /create-forward-hub {devenvId, serverAddr}
 *   POST /start-forward {devenvId, remotePort, localPort}   -> {localPort}
 *   DELETE /delete-forward-hub?devenvId=...
 *
 * The helper exits after ten idle minutes while a forward is open, and the two
 * processes coordinate through a lock file it owns, so we adopt an existing
 * helper instead of starting a second one.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  DEVSPACE_VSIX_URL, HELPER_HEARTBEAT_MS, HELPER_PACKAGE_RELATIVE_PATH, HELPER_RELATIVE_PATH, LOOPBACK,
} from './constants.js'
import { dshHome } from './tokens.js'
import type { Fetcher } from './api.js'

const execFileAsync = promisify(execFile)

/** Where the unpacked extension and the downloaded archive live. */
export interface HelperPaths {
  cacheRoot: string
  archive: string
  unpackRoot: string
  helper: string
  manifest: string
}

/**
 * Resolve the helper's on-disk layout.
 * @param cacheRoot - override, so tests and a deployment can point elsewhere.
 * @returns every path this module touches.
 */
export function helperPaths(cacheRoot: string): HelperPaths {
  const unpackRoot = join(cacheRoot, 'unpacked')
  return {
    cacheRoot,
    archive: join(cacheRoot, 'atomgit-dev-space.vsix'),
    unpackRoot,
    helper: join(unpackRoot, HELPER_RELATIVE_PATH),
    manifest: join(unpackRoot, HELPER_PACKAGE_RELATIVE_PATH),
  }
}

/** Default cache directory under the Harness home. */
export function defaultCacheRoot(): string {
  return join(dshHome(), 'canness', 'devspace-helper')
}

/** The lock file the official extension and this module share. */
export function lockPath(version: string): string {
  return join(homedir(), '.atomgitdevenv', '.hub', 'vscode', `${version}.LOCK`)
}

/** A running helper: its pid and the local HTTP port it listens on. */
export interface HelperLock {
  pid: number
  port: number
}

/**
 * Read the helper's lock file.
 * @param version - extension version, which is part of the file name.
 * @returns the lock, or null when there is none or it is malformed.
 */
export async function readLock(version: string): Promise<HelperLock | null> {
  try {
    const value = (await readFile(lockPath(version), 'utf8')).trim()
    const match = /^(\d+)\|(\d+)$/u.exec(value)
    if (match === null) return null
    return { pid: Number(match[1]), port: Number(match[2]) }
  } catch {
    return null
  }
}

/**
 * Whether a pid is alive.
 * @param pid - process id from the lock file.
 * @returns true when a signal could be delivered.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Unpacked helper metadata. */
export interface UnpackedHelper {
  helper: string
  version: string
}

/**
 * Unpack a `.vsix` (a zip) into the cache directory.
 * Windows has no `unzip`; `tar` there is libarchive and reads zip, and
 * PowerShell's `Expand-Archive` is the last resort.
 * @param archive - the downloaded file.
 * @param unpackRoot - destination directory.
 */
async function unpackVsix(archive: string, unpackRoot: string): Promise<void> {
  await mkdir(unpackRoot, { recursive: true })
  const attempts: Array<{ file: string, args: string[] }> = [
    { file: 'unzip', args: ['-q', '-o', archive, '-d', unpackRoot] },
    { file: 'tar', args: ['-xf', archive, '-C', unpackRoot] },
  ]
  const failures: string[] = []
  for (const attempt of attempts) {
    try {
      await execFileAsync(attempt.file, attempt.args)
      return
    } catch (error) {
      failures.push(`${attempt.file}: ${error instanceof Error ? error.message : 'failed'}`)
    }
  }
  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/gu, "''")}' -DestinationPath '${unpackRoot.replace(/'/gu, "''")}' -Force`,
    ])
    return
  } catch (error) {
    failures.push(`powershell Expand-Archive: ${error instanceof Error ? error.message : 'failed'}`)
  }
  throw new Error(`could not unpack the dev space extension (${failures.join('; ')})`)
}

/**
 * Make sure the unpacked helper is on disk, downloading it on first use.
 * @param fetcher - `fetch` or a test double.
 * @param paths - resolved cache layout.
 * @param onStep - progress reporting.
 * @returns the helper script path and the extension version.
 */
export async function ensureUnpacked(
  fetcher: Fetcher,
  paths: HelperPaths,
  onStep: (step: 'helper-cached' | 'helper-download' | 'helper-unpack', message: string, detail?: string) => void,
): Promise<UnpackedHelper> {
  if (existsSync(paths.helper) && existsSync(paths.manifest)) {
    const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as { version?: unknown }
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
    onStep('helper-cached', 'Port-forwarding helper is already unpacked.', `${paths.helper} (v${version})`)
    return { helper: paths.helper, version }
  }
  await mkdir(paths.cacheRoot, { recursive: true })
  onStep('helper-download', 'Downloading the AtomGit Dev Space extension that ships the forwarder.', DEVSPACE_VSIX_URL)
  const response = await fetcher(DEVSPACE_VSIX_URL, {})
  if (!response.ok) throw new Error(`download dev space extension: HTTP ${String(response.status)}`)
  await writeFile(paths.archive, Buffer.from(await response.arrayBuffer()))
  onStep('helper-unpack', 'Unpacking the extension to reach the forwarding helper.', paths.unpackRoot)
  await unpackVsix(paths.archive, paths.unpackRoot)
  if (!existsSync(paths.helper)) throw new Error('the dev space extension package did not contain the forwarding helper')
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as { version?: unknown }
  const version = typeof manifest.version === 'string' ? manifest.version : 'unknown'
  return { helper: paths.helper, version }
}

/** The helper's local HTTP answer. */
interface HelperReply {
  success?: boolean
  error?: string
  msg?: string
  localPort?: number
}

/**
 * One request to the helper's loopback API.
 * @param port - the helper's listening port.
 * @param path - path with query string.
 * @param options - method and body.
 * @returns the parsed reply.
 */
export async function helperRequest(
  port: number,
  path: string,
  options: { method?: string, body?: string } = {},
): Promise<HelperReply> {
  const response = await fetch(`http://${LOOPBACK}:${String(port)}${path}`, {
    ...options.body === undefined ? {} : { body: options.body },
    ...options.method === undefined ? {} : { method: options.method },
    ...options.body === undefined ? {} : { headers: { 'content-type': 'application/json' } },
  })
  const data = await response.json().catch(() => null) as HelperReply | null
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error ?? data?.msg ?? `helper HTTP ${String(response.status)}`)
  }
  return data ?? {}
}

/**
 * Adopt a live helper, or start one and wait for its lock.
 * @param helper - unpacked helper metadata.
 * @param onStep - progress reporting.
 * @returns the helper's pid and port.
 */
export async function ensureHelperRunning(
  helper: UnpackedHelper,
  onStep: (step: 'helper-start' | 'helper-ready', message: string, detail?: string) => void,
): Promise<HelperLock> {
  const existing = await readLock(helper.version)
  if (existing !== null && processAlive(existing.pid)) {
    try {
      await helperRequest(existing.port, '/heartbeat')
      onStep('helper-ready', 'Reusing the already-running forwarding helper.', `${LOOPBACK}:${String(existing.port)} (pid ${String(existing.pid)})`)
      return existing
    } catch {
      // The lock is stale: fall through and let the helper's own lock guard
      // report a genuine conflict instead of us guessing.
    }
  }
  onStep('helper-start', 'Starting the forwarding helper.', helper.helper)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [helper.helper, '--source', 'vscode', '--enableSSL', 'true'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const lock = await readLock(helper.version)
    if (lock !== null && processAlive(lock.pid)) {
      try {
        await helperRequest(lock.port, '/heartbeat')
        onStep('helper-ready', 'Forwarding helper is up.', `${LOOPBACK}:${String(lock.port)} (pid ${String(lock.pid)})`)
        return lock
      } catch {
        // Still binding its port.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('the forwarding helper did not become ready within 10s')
}

/**
 * Open (or reuse) the forward hub that carries this environment's tunnel.
 * @param port - helper port.
 * @param devenvId - the environment's devstage id.
 * @param serverAddr - the rebased `wss://` URL.
 */
export async function createForwardHub(port: number, devenvId: string, serverAddr: string): Promise<void> {
  await helperRequest(port, '/create-forward-hub', {
    method: 'POST',
    body: JSON.stringify({ devenvId, serverAddr }),
  })
}

/**
 * Expose the environment's remote SSH port on a local loopback port.
 * @param port - helper port.
 * @param devenvId - the environment's devstage id.
 * @param remotePort - remote port to expose, 22 for SSH.
 * @returns the local port the tunnel listens on.
 */
export async function startForward(port: number, devenvId: string, remotePort: number): Promise<number> {
  const reply = await helperRequest(port, '/start-forward', {
    method: 'POST',
    body: JSON.stringify({ devenvId, remotePort, localPort: 0 }),
  })
  if (typeof reply.localPort !== 'number' || reply.localPort <= 0) {
    throw new Error('the forwarding helper did not report a local port')
  }
  return reply.localPort
}

/**
 * Close one forward hub. Best effort: the helper also exits when idle.
 * @param port - helper port.
 * @param devenvId - the environment's devstage id.
 */
export async function deleteForwardHub(port: number, devenvId: string): Promise<void> {
  try {
    await helperRequest(port, `/delete-forward-hub?devenvId=${encodeURIComponent(devenvId)}`, { method: 'DELETE' })
  } catch {
    // Cleanup failure never overrides the outcome the caller already reported.
  }
}

/**
 * Keep the helper from reaping an idle tunnel for as long as we hold it open.
 * @param port - helper port.
 * @param intervalMs - heartbeat period.
 * @returns the stopper.
 */
export function startHelperKeepalive(port: number, intervalMs: number = HELPER_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    helperRequest(port, '/heartbeat').catch(() => {
      // A transient failure is not worth surfacing: the SSH connection itself
      // reports a tunnel that actually broke.
    })
  }, intervalMs)
  timer.unref()
  return () => { clearInterval(timer) }
}
