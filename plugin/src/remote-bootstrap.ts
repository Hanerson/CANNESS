import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExecResult, RemoteHost } from './remote.js'

export interface BootstrapInput {
  inbox: string
  outbox: string
  /** `bootstrapCommand`; empty means "deploy the bundled mock consumer". */
  command: string
  /** `bootstrap`; false skips every remote preparation step. */
  enabled: boolean
  /** How long the started consumer has to stay alive. */
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type BootstrapResult =
  | { ok: true; consumer: 'reused' | 'started' | 'command' }
  | { ok: false; reason: string }

/** Where `watch.py` sits relative to the built module (`lib/remote-bootstrap.js`). */
export const WATCH_SCRIPT_FROM_LIB = '../../remote/watch.py'
const WATCH_SCRIPT_FROM_SRC = '../remote/watch.py'

/** `python` candidates in preference order; resolved with `command -v` on the host. */
export const PYTHON_CANDIDATES = ['python3', 'python'] as const

const DEFAULT_READY_TIMEOUT_MS = 10_000
const DEFAULT_READY_INTERVAL_MS = 250
const WATCH_INTERVAL_MS = 2000
const STDERR_SUMMARY_LIMIT = 200

/** Single-quote a value for POSIX sh; embedded quotes become `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function summarize(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  if (flat === '') return '(no output)'
  return flat.length <= STDERR_SUMMARY_LIMIT ? flat : `${flat.slice(0, STDERR_SUMMARY_LIMIT)}…`
}

/** Package-local mock consumer; resolved against `lib/` first, then the `src/` layout used by tests. */
export function watchScriptFile(): string {
  const fromLib = new URL(WATCH_SCRIPT_FROM_LIB, import.meta.url)
  if (existsSync(fileURLToPath(fromLib))) return fileURLToPath(fromLib)
  return fileURLToPath(new URL(WATCH_SCRIPT_FROM_SRC, import.meta.url))
}

/** `kill -0` on the pid recorded in `pidPath`; false when the file or process is gone. */
export function pidAliveCommand(pidPath: string): string {
  return `kill -0 "$(cat ${shellQuote(pidPath)} 2>/dev/null)" 2>/dev/null`
}

/** Bracketed pattern so the probe does not match its own `sh -c` command line. */
export const WATCH_PROCESS_COMMAND = "pgrep -f '[w]atch.py'"

export function startCommand(python: string, script: string, baseDir: string, inbox: string, outbox: string): string {
  const log = posix.join(baseDir, 'watch.log')
  const pid = posix.join(baseDir, 'watch.pid')
  return [
    `nohup ${shellQuote(python)} ${shellQuote(script)} --inbox ${shellQuote(inbox)} --outbox ${shellQuote(outbox)} --loop --interval ${WATCH_INTERVAL_MS} >> ${shellQuote(log)} 2>&1 &`,
    `echo $! > ${shellQuote(pid)}`,
  ].join('\n')
}

/** First candidate that `command -v` resolves; the resolved path is what gets executed. */
export async function pythonCommand(host: RemoteHost): Promise<string | null> {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = await host.exec(`command -v ${candidate}`)
    if (probe.code === 0) {
      const resolved = probe.stdout.trim().split('\n')[0]?.trim() ?? ''
      if (resolved !== '') return resolved
    }
  }
  return null
}

async function pidAlive(host: RemoteHost, pidPath: string): Promise<boolean> {
  const result = await host.exec(pidAliveCommand(pidPath))
  return result.code === 0
}

async function consumerRunning(host: RemoteHost, pidPath: string): Promise<boolean> {
  if (await host.stat(pidPath) !== null && await pidAlive(host, pidPath)) return true
  return (await host.exec(WATCH_PROCESS_COMMAND)).code === 0
}

async function waitForPid(host: RemoteHost, pidPath: string, input: BootstrapInput): Promise<boolean> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const timeoutMs = input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const intervalMs = input.intervalMs ?? DEFAULT_READY_INTERVAL_MS
  const start = now()
  for (;;) {
    if (await pidAlive(host, pidPath)) return true
    if (now() - start >= timeoutMs) return false
    await sleep(intervalMs)
  }
}

/**
 * Idempotent remote preparation before an upload: make the directories, then
 * either reuse a running consumer, run `bootstrapCommand`, or deploy and start
 * the bundled `watch.py`. Never replaces an existing `watch.py`.
 */
export async function ensureRemoteConsumer(host: RemoteHost, input: BootstrapInput): Promise<BootstrapResult> {
  if (!input.enabled) return { ok: true, consumer: 'reused' }
  const baseDir = posix.dirname(posix.normalize(input.inbox))

  for (const dir of [input.inbox, input.outbox]) {
    try {
      await host.mkdirp(dir)
    } catch (error) {
      return { ok: false, reason: `mkdir ${dir}: ${messageOf(error)}` }
    }
  }

  const pidPath = posix.join(baseDir, 'watch.pid')
  let running: boolean
  try {
    running = await consumerRunning(host, pidPath)
  } catch (error) {
    return { ok: false, reason: `probe consumer: ${messageOf(error)}` }
  }
  if (running) return { ok: true, consumer: 'reused' }

  const command = input.command.trim()
  if (command !== '') {
    let result: ExecResult
    try {
      result = await host.exec(command)
    } catch (error) {
      return { ok: false, reason: `bootstrapCommand failed: ${messageOf(error)}` }
    }
    if (result.code !== 0) {
      return { ok: false, reason: `bootstrapCommand exited ${result.code}: ${summarize(result.stderr)}` }
    }
    return { ok: true, consumer: 'command' }
  }

  const script = posix.join(baseDir, 'watch.py')
  try {
    if (await host.stat(script) === null) await host.put(watchScriptFile(), script)
  } catch (error) {
    return { ok: false, reason: `deploy watch.py: ${messageOf(error)}` }
  }

  let python: string | null
  try {
    python = await pythonCommand(host)
  } catch (error) {
    return { ok: false, reason: `probe python: ${messageOf(error)}` }
  }
  if (python === null) return { ok: false, reason: 'python3 not found on remote' }

  try {
    const started = await host.exec(startCommand(python, script, baseDir, input.inbox, input.outbox))
    if (started.code !== 0) {
      return { ok: false, reason: `start consumer exited ${started.code}: ${summarize(started.stderr)}` }
    }
  } catch (error) {
    return { ok: false, reason: `start consumer failed: ${messageOf(error)}` }
  }

  if (!await waitForPid(host, pidPath, input)) {
    return { ok: false, reason: 'consumer exited immediately after start' }
  }
  return { ok: true, consumer: 'started' }
}
