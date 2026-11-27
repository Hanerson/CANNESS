import { randomUUID, createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runnerScriptFile } from './eval-run.js'
import { shellQuote, type RemoteHost } from './remote.js'
import type { JsonValue } from './report.js'
import { retainCompletedAttempts } from './retention.js'

export interface SubmissionValidationInput {
  sourceDir: string
  remoteRoot: string
  setEnv?: string
  testScript?: string
  timeoutSec?: number
  casesFile?: string
  caseTimeoutSec?: number
  device?: string
  deviceLock?: string
  retainAttempts?: number
}

export function unverifiedSubmissionStages(): JsonValue {
  return { build: { status: 'unverified' }, install: { status: 'unverified' }, call: { status: 'unverified' }, accuracy: { status: 'unverified' } }
}
export function submissionSourceHash(root: string): string {
  const actual = new Set<string>()
  const walk = (dir: string, prefix = '') => {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('submission symlinks are not allowed')
    for (const name of readdirSync(dir)) {
      const rel = prefix + name, path = join(dir, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('submission symlinks are not allowed')
      if (stat.isDirectory()) walk(path, rel + '/')
      else if (stat.isFile() && rel !== 'provenance.json') actual.add(rel)
      else if (!stat.isFile()) throw new Error('submission contains a non-regular file')
    }
  }
  walk(root)
  const provenance = readFileSync(join(root, 'provenance.json'), 'utf8')
  const declared = JSON.parse(provenance).files as Record<string, string>
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error('invalid provenance.files')
  for (const [name, hash] of Object.entries(declared)) {
    if (!actual.delete(name) || !/^[a-f0-9]{64}$/i.test(hash) || createHash('sha256').update(readFileSync(join(root, name))).digest('hex') !== hash.toLowerCase()) throw new Error(`submission provenance mismatch: ${name}`)
  }
  if (actual.size) throw new Error('submission contains unhashed files')
  return createHash('sha256').update(provenance).digest('hex')
}
export async function validateSubmission(files: RemoteHost, input: SubmissionValidationInput): Promise<JsonValue> {
  const timeout = Math.max(1, Math.min(3600, Math.round(input.timeoutSec ?? 600)))
  const remoteDir = posix.join(input.remoteRoot, `submission-validation-${randomUUID()}`)
  const failure = (reason: string): JsonValue => ({ status: 'failed', correctness: 'unverified', stages: unverifiedSubmissionStages(), remoteDir, reason })
  const temp = mkdtempSync(join(tmpdir(), 'canness-submission-validation-'))
  try {
    const sourceHash = submissionSourceHash(input.sourceDir)
    if (input.device && !/^\d+$/.test(input.device)) throw new Error('device ID must be a nonnegative integer')
    if (input.casesFile) {
      if (!input.testScript) throw new Error('cases_file requires a test_script')
      const stat = lstatSync(input.casesFile)
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('cases_file must be a regular CSV file of at most 1 MiB')
    }
    await files.mkdirp(remoteDir)
    await files.uploadDir(input.sourceDir, posix.join(remoteDir, 'source'))
    const built = fileURLToPath(new URL('../../remote/validate_submission.py', import.meta.url))
    const runner = existsSync(built) ? built : fileURLToPath(new URL('../remote/validate_submission.py', import.meta.url))
    await files.put(runner, posix.join(remoteDir, 'validate_submission.py'))
    await files.put(runnerScriptFile(), posix.join(remoteDir, 'runner.py'))
    if (input.testScript !== undefined) {
      writeFileSync(join(temp, 'test.py'), input.testScript)
      await files.put(join(temp, 'test.py'), posix.join(remoteDir, 'test.py'))
    }
    if (input.casesFile) await files.put(input.casesFile, posix.join(remoteDir, 'cases.csv'))
    const command = `python3 ${shellQuote(posix.join(remoteDir, 'validate_submission.py'))} --root ${shellQuote(remoteDir)} --timeout-sec ${timeout}`
      + (input.setEnv ? ` --set-env ${shellQuote(input.setEnv)}` : '')
      + (input.testScript !== undefined ? ' --test-script test.py' : '')
      + (input.device ? ` --device-id ${shellQuote(input.device)}` : '')
      + (input.deviceLock !== undefined ? ` --lock ${shellQuote(input.deviceLock)}` : '')
      + (input.casesFile ? ' --cases-file cases.csv' : '')
      + (input.caseTimeoutSec === undefined ? '' : ` --case-timeout-sec ${Math.max(1, Math.min(3600, Math.round(input.caseTimeoutSec)))}`)
    const result = await files.exec(command)
    const line = result.stdout.split(/\r?\n/).filter(row => row.startsWith('CANNESS_SUBMISSION_REPORT ')).at(-1)
    if (!line) {
      // An empty reply with exit 0 means the channel dropped mid-run, which a
      // bare "runner exited 0:" cannot convey. Report what actually came back.
      return failure(`no CANNESS_SUBMISSION_REPORT line: runner exited ${result.code}, `
        + `stdout ${result.stdout.length}B, stderr ${result.stderr.length}B`
        + (result.stderr ? `; stderr tail: ${result.stderr.slice(-2000)}` : ''))
    }
    const report = JSON.parse(line.slice('CANNESS_SUBMISSION_REPORT '.length))
    if (result.code !== 0 && report.status !== 'failed') return failure(`runner exited ${result.code}`)
    await retainCompletedAttempts(files, 'validation', {
      inbox: input.remoteRoot, current: posix.basename(remoteDir),
    }, input.retainAttempts)
    return { ...report, remoteDir, sourceHash }
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)) }
  finally { rmSync(temp, { recursive: true, force: true }) }
}
