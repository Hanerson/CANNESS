import { malformedReport, parseReport, timeoutReport, type EvalReport } from './report.js'
import { applyReport, stopReason, type PolicyConfig, type TaskState } from './policy.js'
import { waitForRemoteFile, type RemoteFiles } from './remote.js'

export interface RunInput {
  files: RemoteFiles
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
}

export async function runEvaluation(input: RunInput): Promise<{ report: EvalReport; state: TaskState }> {
  const reason = stopReason(input.state, input.config)
  if (reason) {
    return {
      report: {
        generationId: input.generationId,
        status: 'error',
        compile: { ok: false, log: '' },
        correctness: { ok: false, maxRelativeError: null },
        performance: { kernelTimeUs: null, targetUs: null },
        analysis: null,
        summary: `stopped: ${reason}`,
      },
      state: input.state,
    }
  }
  const remoteDir = `${input.inbox}/${input.generationId}`
  const resultPath = `${input.outbox}/${input.generationId}/results.json`
  await input.files.uploadDir(input.localPackageDir, remoteDir)
  try {
    const body = await waitForRemoteFile(input.files, resultPath, {
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
  }
}
