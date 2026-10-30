import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { runEvaluation } from './eval-run.js'
import { loadState, saveState } from './state-file.js'
import { connectSftp, type SftpOptions } from './ssh2-transport.js'
import type { RemoteFiles } from './remote.js'
import { stoppedReport, type EvalReport } from './report.js'
import { stopReason, type PolicyConfig } from './policy.js'

export const name = 'canness-eval'
export const inject = ['tools']

// Every field the settings card edits must be volatile: the dsh settings
// service refuses writes to non-volatile paths, and volatile references are
// re-read per operation so a card save takes effect without a remount.
export interface Config {
  workspace: string
  host: Volatile<string>
  port: Volatile<number>
  username: Volatile<string>
  privateKeyPath: Volatile<string>
  passwordEnv: Volatile<string>
  inbox: Volatile<string>
  outbox: Volatile<string>
  timeoutSec: Volatile<number>
  pollIntervalMs: Volatile<number>
  maxIterations: Volatile<number>
  maxCompileRetries: Volatile<number>
  negativeStreakLimit: Volatile<number>
  convergenceThreshold: Volatile<number>
}

export const Config = z.object({
  workspace: z.string().required(),
  host: z.string().required().volatile(),
  port: z.number().required().volatile(),
  username: z.string().required().volatile(),
  privateKeyPath: z.string().required().volatile(),
  passwordEnv: z.string().role('credential-ref').default('CANNNESS_SSH_PASSWORD').volatile(),
  inbox: z.string().required().volatile(),
  outbox: z.string().required().volatile(),
  timeoutSec: z.number().required().volatile(),
  pollIntervalMs: z.number().required().volatile(),
  maxIterations: z.number().required().volatile(),
  maxCompileRetries: z.number().required().volatile(),
  negativeStreakLimit: z.number().required().volatile(),
  convergenceThreshold: z.number().required().volatile(),
})

function emptyHostReport(generationId: string | null): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: 'ssh host is empty',
  }
}

function missingCredentialsReport(generationId: string | null): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: 'ssh credentials missing',
  }
}

function connectFailedReport(generationId: string | null, detail: string): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `ssh connect failed: ${detail}`,
  }
}

/** One consistent read of the volatile fields, captured when an operation starts. */
function snapshot(config: Config) {
  return {
    host: config.host.get(),
    port: config.port.get(),
    username: config.username.get(),
    privateKeyPath: config.privateKeyPath.get(),
    passwordEnv: config.passwordEnv.get(),
    inbox: config.inbox.get(),
    outbox: config.outbox.get(),
    timeoutSec: config.timeoutSec.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
  }
}

function policyOf(config: Config): PolicyConfig {
  return {
    maxIterations: config.maxIterations.get(),
    maxCompileRetries: config.maxCompileRetries.get(),
    negativeStreakLimit: config.negativeStreakLimit.get(),
    convergenceThreshold: config.convergenceThreshold.get(),
  }
}

/** Private key when a path is configured, otherwise the credentials-seam password. */
async function resolveAuth(ctx: Context, cfg: ReturnType<typeof snapshot>): Promise<Pick<SftpOptions, 'privateKey' | 'password'>> {
  if (cfg.privateKeyPath !== '') return { privateKey: readFileSync(cfg.privateKeyPath, 'utf8') }
  const credentials = ctx.get('credentials')
  // No provider mounted (minimal profile) or no value stored both read as "not configured".
  if (credentials === undefined || !isCredentialRefName(cfg.passwordEnv)) return {}
  const hit = await credentials.resolve(credentialRef(cfg.passwordEnv))
  return hit === undefined ? {} : { password: hit.value }
}

export function apply(
  ctx: Context,
  config: Config,
  connect: (opts: SftpOptions) => Promise<RemoteFiles> = connectSftp,
): void {
  const path = join(config.workspace, '.canness', 'state.json')
  ctx.tools.register(defineTool({
    name: 'run_evaluation',
    description: 'Upload the current test package over SFTP and wait for results.json. Does not compile locally.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { type: 'string', required: true },
          status: {
            type: 'string',
            required: true,
            enum: ['pass', 'compile_fail', 'accuracy_fail', 'perf_fail', 'timeout', 'error'],
          },
          compile: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'boolean', required: true },
              log: { type: 'string', required: true },
            },
          },
          correctness: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              ok: { type: 'boolean', required: true },
              maxRelativeError: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          performance: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              kernelTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
              targetUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          analysis: {
            required: true,
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true, enum: ['msprof-mock', 'msprof'] },
                  bottleneck: { type: 'string', required: true, enum: ['cube', 'memory', 'scalar', 'unknown'] },
                  summary: { type: 'string', required: true },
                  op: {
                    required: true,
                    oneOf: [
                      { type: 'null' },
                      {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          opName: { type: 'string', required: true },
                          opType: { type: 'string', required: true },
                          taskType: { type: 'string', required: true },
                          taskDurationUs: { type: 'number', required: true },
                          taskWaitTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          blockDim: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicoreTimeUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicMacRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicMte2Ratio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          aicScalarRatio: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                          cubeUtilizationPct: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const cfg = snapshot(config)
      const state = loadState(path)
      if (cfg.host === '') return emptyHostReport(state.generationId)
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(config.workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) throw new Error('build_test_package first')
      const reason = stopReason(state, policyOf(config))
      if (reason) return stoppedReport(state.generationId, reason)
      const auth = await resolveAuth(ctx, cfg)
      if (auth.privateKey === undefined && auth.password === undefined) {
        return missingCredentialsReport(state.generationId)
      }
      let files: RemoteFiles
      try {
        files = await connect({ host: cfg.host, port: cfg.port, username: cfg.username, ...auth })
      } catch (error) {
        return connectFailedReport(state.generationId, error instanceof Error ? error.message : 'unknown')
      }
      try {
        const { report, state: next } = await runEvaluation({
          files,
          localPackageDir,
          generationId: state.generationId,
          inbox: cfg.inbox,
          outbox: cfg.outbox,
          timeoutMs: cfg.timeoutSec * 1000,
          intervalMs: cfg.pollIntervalMs,
          state,
          config: policyOf(config),
        })
        saveState(path, next)
        return report
      } finally {
        await files.close()
      }
    },
  }))
}
