import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { malformedReport, parseReport, stoppedReport, timeoutReport, type EvalReport } from './report.js'
import { applyReport, stopReason, type PolicyConfig, type TaskState } from './policy.js'
import { firstLines, shellQuote, waitForRemoteFile, type RemoteHost } from './remote.js'

/** Where `runner.py` sits relative to the built module (`lib/eval-run.js`). */
const RUNNER_FROM_LIB = '../../remote/runner.py'
const RUNNER_FROM_SRC = '../remote/runner.py'

export interface RunInput {
  files: RemoteHost
  localPackageDir: string
  generationId: string
  inbox: string
  outbox: string
  timeoutMs: number
  intervalMs: number
  state: TaskState
  config: PolicyConfig
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Per-run temporary-name source; tests pin it so command strings are stable. */
  token?: () => string
}

/**
 * Package-local runner, resolved against `lib/` first and then the `src/`
 * layout used by tests, mirroring how shipped files are located.
 */
export function runnerScriptFile(): string {
  const fromLib = new URL(RUNNER_FROM_LIB, import.meta.url)
  if (existsSync(fileURLToPath(fromLib))) return fileURLToPath(fromLib)
  return fileURLToPath(new URL(RUNNER_FROM_SRC, import.meta.url))
}

/**
 * The one shell line that starts the real runner.
 *
 * `python3` is preferred, `python` is the fallback. The command is bounded by
 * `timeout` when the host has it, so a hung msprof cannot hold the SSH channel
 * forever, and exit 124 stays distinguishable as a timeout rather than a
 * generic failure.
 */
export function runnerCommand(input: {
  runnerPath: string
  inbox: string
  outbox: string
  generationId: string
  timeoutSec: number
}): string {
  const python = 'PY=$(command -v python3 || command -v python) || { echo "python3 not found on remote" >&2; exit 127; }; '
  const timeout = `if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout --kill-after=10s ${Math.max(1, Math.round(input.timeoutSec))}s"; else TIMEOUT=""; fi; `
  return `${python}${timeout}$TIMEOUT "$PY" ${shellQuote(input.runnerPath)}`
    + ` --inbox ${shellQuote(input.inbox)} --outbox ${shellQuote(input.outbox)}`
    + ` --generation ${shellQuote(input.generationId)} --once`
}

function runnerFailedReport(generationId: string, detail: string): EvalReport {
  return {
    generationId,
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `remote runner failed: ${detail}`,
  }
}

/**
 * Upload one package, execute the real remote runner, and parse its report.
 *
 * The runner is uploaded next to the configured inbox (not inside the package)
 * under a uuid name, so concurrent evaluations cannot overwrite each other and
 * the package contract stays exactly what the generator produced.
 */
export async function runEvaluation(input: RunInput): Promise<{ report: EvalReport; state: TaskState }> {
  const reason = stopReason(input.state, input.config)
  if (reason) return { report: stoppedReport(input.generationId, reason), state: input.state }
  const remoteDir = `${input.inbox}/${input.generationId}`
  const resultPath = `${input.outbox}/${input.generationId}/results.json`
  const baseDir = posix.dirname(posix.normalize(input.inbox))
  const token = (input.token ?? (() => randomUUID().slice(0, 12)))()
  const runnerPath = posix.join(baseDir, `runner-${token}.py`)

  await input.files.uploadDir(input.localPackageDir, remoteDir)
  // The runner skips a generation whose results.json already exists, so drop
  // the previous attempt before starting a new one.
  await input.files.removeFile(resultPath)
  try {
    await input.files.put(runnerScriptFile(), runnerPath)
    const started = await input.files.exec(runnerCommand({
      runnerPath,
      inbox: input.inbox,
      outbox: input.outbox,
      generationId: input.generationId,
      timeoutSec: Math.round(input.timeoutMs / 1000),
    }))
    if (started.code === 124) {
      const report = timeoutReport(input.generationId, Math.round(input.timeoutMs / 1000))
      return { report, state: applyReport(input.state, report) }
    }
    const early = await input.files.readFile(resultPath)
    if (early === null && started.code !== 0) {
      const detail = firstLines(started.stderr, 20) || firstLines(started.stdout, 20) || `exit ${started.code}`
      const report = runnerFailedReport(input.generationId, detail)
      return { report, state: applyReport(input.state, report) }
    }
    const body = early ?? await waitForRemoteFile(input.files, resultPath, {
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs,
      now: input.now,
      sleep: input.sleep,
    })
    const report = parseReport(JSON.parse(Buffer.from(body).toString('utf8')))
    return { report, state: applyReport(input.state, report) }
  } catch (error) {
    const report = error instanceof Error && error.message === 'timeout'
      ? timeoutReport(input.generationId, Math.round(input.timeoutMs / 1000))
      : malformedReport(input.generationId, error instanceof Error ? error.message : 'unknown')
    return { report, state: applyReport(input.state, report) }
  } finally {
    // Best-effort: a stale temp script is harmless, a failed cleanup is not a
    // reason to lose the report above.
    await input.files.removeFile(runnerPath).catch(() => {})
  }
}
