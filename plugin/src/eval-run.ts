import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { malformedReport, parseReport, stoppedReport, timeoutReport, type EvalReport, type JsonValue } from './report.js'
import { applyReport, canForceEvaluation, stopReason, type PolicyConfig, type TaskState } from './policy.js'
import { firstLines, shellQuote, waitForRemoteFile, type RemoteHost } from './remote.js'
import { packageHash, requireFreshBuild } from './package-files.js'
import { retainCompletedAttempts } from './retention.js'

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
  setEnv?: string
  device?: string
  deviceLock?: string
  retainAttempts?: number
  force?: boolean
  compileOnly?: boolean
  accuracyOnly?: boolean
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
  setEnv?: string
  device?: string
  deviceLock?: string
  compileOnly?: boolean
  accuracyOnly?: boolean
}): string {
  const budgetSec = Math.max(1, Math.round(input.timeoutSec))
  // Give the runner time to terminate its subprocess and publish its report.
  const timeout = `if command -v timeout >/dev/null 2>&1; then TIMEOUT="timeout --kill-after=10s ${budgetSec + 10}s"; else TIMEOUT=""; fi; `
  return `${findPython}${timeout}$TIMEOUT "$PY" ${shellQuote(input.runnerPath)}`
    + ` --inbox ${shellQuote(input.inbox)} --outbox ${shellQuote(input.outbox)}`
    + ` --generation ${shellQuote(input.generationId)} --once --budget-sec ${budgetSec}`
    + (input.setEnv ? ` --set-env ${shellQuote(input.setEnv)}` : '')
    + deviceFlags(input)
    + (input.compileOnly ? ' --compile-only' : '')
    + (input.accuracyOnly ? ' --accuracy-only' : '')
}

const findPython = 'PY=$(command -v python3 || command -v python) || { echo "python3 not found on remote" >&2; exit 127; }; '

function deviceFlags(input: { device?: string; deviceLock?: string }): string {
  return (input.device ? ` --device ${shellQuote(input.device)}` : '')
    + (input.deviceLock ? ` --lock ${shellQuote(input.deviceLock)}` : '')
}

/** Run the runner's toolchain check from stdin, without creating remote files. */
export async function preflightToolchain(files: RemoteHost, setEnv: string, device?: string, deviceLock?: string): Promise<JsonValue> {
  const script = readFileSync(runnerScriptFile()).toString('base64')
  const result = await files.exec(`${findPython}printf %s ${shellQuote(script)} | base64 -d | "$PY" - --preflight`
    + (setEnv ? ` --set-env ${shellQuote(setEnv)}` : '') + deviceFlags({ device, deviceLock }))
  if (result.code !== 0) {
    throw new Error(firstLines(result.stderr, 4) || `CANN toolchain probe exited with code ${result.code}`)
  }
  const facts = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? '') as JsonValue
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts) || typeof facts.ready !== 'boolean') {
    throw new Error('CANN toolchain probe returned malformed data')
  }
  return facts
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
 * Each attempt gets its own remote input and output directories. Keep its
 * logical generation ID unchanged so runner reports still identify the package.
 */
export async function runEvaluation(input: RunInput): Promise<{
  report: EvalReport
  state: TaskState
  resultWritten: boolean
  resultsPath?: string
}> {
  requireFreshBuild()
  const reason = stopReason(input.state, input.config)
  const diagnostic = input.compileOnly || input.accuracyOnly
  if (reason && !diagnostic && !(input.force && canForceEvaluation(input.state, input.config))) {
    return { report: stoppedReport(input.generationId, reason), state: input.state, resultWritten: false }
  }
  const fold = (report: EvalReport): TaskState => diagnostic ? input.state
    : { ...applyReport({ ...input.state, packageHash: input.state.packageHash ?? packageHash(input.localPackageDir) }, report),
        forcedRunsAfterStop: (input.state.forcedRunsAfterStop ?? 0) + (reason && input.force ? 1 : 0) }
  const manifestPath = join(input.localPackageDir, 'manifest.json')
  if (!input.compileOnly && existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { packageHash?: string }
    const actual = packageHash(input.localPackageDir)
    if (manifest.packageHash && manifest.packageHash !== actual) {
      throw new Error(`package changed after build_test_package: manifest=${manifest.packageHash}, `
        + `actual=${actual}; rebuild or repair before upload`)
    }
  }
  const generation = input.compileOnly ? `${input.generationId}-compile-${randomUUID().slice(0, 8)}` : input.generationId
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(generation)) {
    throw new Error(`unsafe evaluation generation id: ${generation}`)
  }
  const baseDir = posix.dirname(posix.normalize(input.inbox))
  const token = input.token?.() ?? randomUUID()
  if (!/^[A-Za-z0-9_-]+$/u.test(token)) throw new Error('unsafe evaluation attempt token')
  const runnerPath = posix.join(baseDir, `runner-${token}.py`)
  const attempt = posix.join(generation, `attempt-${token}`)
  const inbox = input.compileOnly ? input.inbox : posix.join(input.inbox, attempt)
  const outbox = input.compileOnly ? input.outbox : posix.join(input.outbox, attempt)
  const resultPath = posix.join(outbox, generation, 'results.json')
  let complete = false

  await input.files.uploadDir(input.localPackageDir, posix.join(inbox, generation))
  try {
    await input.files.put(runnerScriptFile(), runnerPath)
    const started = await input.files.exec(runnerCommand({
      runnerPath,
      inbox,
      outbox,
      generationId: generation,
      timeoutSec: Math.round(input.timeoutMs / 1000),
      setEnv: input.setEnv,
      device: input.device,
      deviceLock: input.deviceLock,
      compileOnly: input.compileOnly,
      accuracyOnly: input.accuracyOnly,
    }))
    if (started.code === 124) {
      try {
        const written = await input.files.readFile(resultPath)
        if (written !== null) {
          const raw = JSON.parse(Buffer.from(written).toString('utf8'))
          const report = parseReport(raw)
          if (report.generationId === generation && raw.status === report.status && typeof raw.summary === 'string'
            && typeof raw.compile?.ok === 'boolean' && typeof raw.correctness?.ok === 'boolean' && raw.performance != null) {
            complete = true
            return { report, state: fold(report), resultWritten: true, resultsPath: resultPath }
          }
        }
      } catch {
        // A missing, unreadable or incomplete report leaves the timeout authoritative.
      }
      const report = timeoutReport(input.generationId, Math.round(input.timeoutMs / 1000))
      return { report, state: fold(report), resultWritten: false }
    }
    const early = await input.files.readFile(resultPath)
    if (early === null && started.code !== 0) {
      const detail = firstLines(started.stderr, 20) || firstLines(started.stdout, 20) || `exit ${started.code}`
      const report = runnerFailedReport(input.generationId, detail)
      return { report, state: fold(report), resultWritten: false }
    }
    const body = early ?? await waitForRemoteFile(input.files, resultPath, {
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs,
      now: input.now,
      sleep: input.sleep,
    })
    const report = parseReport(JSON.parse(Buffer.from(body).toString('utf8')))
    complete = report.generationId === generation
    return { report, state: fold(report), resultWritten: true, resultsPath: resultPath }
  } catch (error) {
    const report = error instanceof Error && error.message === 'timeout'
      ? timeoutReport(input.generationId, Math.round(input.timeoutMs / 1000))
      : malformedReport(input.generationId, error instanceof Error ? error.message : 'unknown')
    return { report, state: fold(report), resultWritten: false }
  } finally {
    // Best-effort: a stale temp script is harmless, a failed cleanup is not a
    // reason to lose the report above.
    await input.files.removeFile(runnerPath).catch(() => {})
    if (complete && !diagnostic) await retainCompletedAttempts(input.files, 'eval', {
      inbox: input.inbox, outbox: input.outbox, generation, current: `attempt-${token}`,
    }, input.retainAttempts)
  }
}
