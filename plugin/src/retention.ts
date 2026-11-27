import { readFileSync } from 'node:fs'
import { shellQuote, type RemoteHost } from './remote.js'

/** Retention runs on completed attempts only. A cleanup error must not hide a report. */
export async function retainCompletedAttempts(
  files: RemoteHost,
  kind: 'eval' | 'validation',
  roots: { inbox: string; outbox?: string; generation?: string; current: string },
  keep: number | undefined,
): Promise<void> {
  if (keep === undefined || !Number.isSafeInteger(keep) || keep < 1) return
  try {
    const source = readFileSync(new URL('../remote/retention.py', import.meta.url)).toString('base64')
    let args = `${kind} --inbox ${shellQuote(roots.inbox)} --current ${shellQuote(roots.current)} --keep ${keep}`
    if (kind === 'eval' && roots.outbox !== undefined && roots.generation !== undefined) {
      args = `eval --inbox ${shellQuote(roots.inbox)} --outbox ${shellQuote(roots.outbox)} --generation ${shellQuote(roots.generation)} --current ${shellQuote(roots.current)} --keep ${keep}`
    }
    const python = 'PY=$(command -v python3 || command -v python) || exit 127; '
    const cap = 'if command -v timeout >/dev/null 2>&1; then CAP="timeout --kill-after=5s 20s"; else CAP=""; fi; '
    await files.exec(`${python}${cap}printf %s ${shellQuote(source)} | base64 -d | $CAP "$PY" - ${args}`)
  } catch {
    // The result remains available and a later successful attempt can retry cleanup.
  }
}
