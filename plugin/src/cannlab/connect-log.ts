/**
 * A durable copy of the last connect attempt.
 *
 * The card's log lives in browser memory: a reload, a closed panel, or a
 * dropped event stream takes the evidence with it. This file keeps one line
 * per stage on disk, so a failed attempt can be read afterwards — by the user,
 * and by anyone troubleshooting with them — without reproducing it.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CannlabEvent } from './types.js'

/** Header written at the start of every attempt. */
function header(): string {
  return `# CANNLab connect attempt ${new Date().toISOString()}\n`
}

/**
 * Truncate the log and write the attempt header.
 *
 * The trace is a diagnostic, never a precondition: an unwritable path — or a
 * value that is not a path at all — yields a log that records nothing, so the
 * connect attempt still runs and the card still shows every line.
 * @param path - absolute path of the attempt log.
 * @returns the appender for this attempt.
 */
export function startAttemptLog(path: string): {
  append: (event: CannlabEvent) => void
} {
  if (typeof path !== 'string' || path.length === 0) return { append: () => {} }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, header(), { encoding: 'utf8', mode: 0o600 })
  } catch {
    return { append: () => {} }
  }
  return {
    append(event: CannlabEvent): void {
      const at = new Date(event.at).toISOString()
      const detail = event.detail === undefined ? '' : ` :: ${event.detail}`
      try {
        appendFileSync(path, `${at} ${event.level.padEnd(5)} ${event.step} ${event.message}${detail}\n`, 'utf8')
      } catch {
        // Writing the trace must never be able to fail a connect attempt; the
        // card still shows every line the Host emits.
      }
    },
  }
}

/** Path of the standard attempt log under a Harness home. */
export function attemptLogPath(home: string): string {
  return join(home, 'canness', 'cannlab', 'last-connect.log')
}

/** Recover the last matching successful connection after a Harness restart. */
export function loggedTunnel(
  path: string,
  host: string,
  port: number,
  keyPath: string,
): { name: string; instanceId: string; helperPort: number | null; connectedAt: string } | null {
  if (host !== '127.0.0.1' || keyPath === '') return null
  let lines: string[]
  try {
    lines = readFileSync(path, 'utf8').split(/\r?\n/u)
  } catch {
    return null
  }
  const done = lines.findLast(line => line.endsWith(`@${host}:${port} via ${keyPath}`))
    ?.match(/^(\S+) done\s+done Connected to "(.*)"\. :: /u)
  const selected = lines.findLast(line => /^\S+ info\s+selecting /u.test(line))
    ?.match(/ :: id (\S+) · devstage /u)
  if (!done || !selected) return null
  const helper = lines.findLast(line => /^\S+ info\s+helper-ready /u.test(line))
    ?.match(/ :: 127\.0\.0\.1:(\d+) \(pid \d+\)$/u)
  return {
    name: done[2]!,
    instanceId: selected[1]!,
    helperPort: helper ? Number(helper[1]) : null,
    connectedAt: done[1]!,
  }
}
