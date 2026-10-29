import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { runEvaluation } from './eval-run.js'
import { loadState, saveState } from './state-file.js'
import { connectSftp } from './ssh2-transport.js'
import type { EvalReport } from './report.js'
import type { PolicyConfig } from './policy.js'

export const name = 'canness-eval'
export const inject = ['tools']

export interface Config extends PolicyConfig {
  workspace: string
  host: string
  port: number
  username: string
  privateKeyPath: string
  inbox: string
  outbox: string
  timeoutSec: number
  pollIntervalMs: number
}

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  host: z.string().required(),
  port: z.number().required(),
  username: z.string().required(),
  privateKeyPath: z.string().required(),
  inbox: z.string().required(),
  outbox: z.string().required(),
  timeoutSec: z.number().required(),
  pollIntervalMs: z.number().required(),
  maxIterations: z.number().required(),
  maxCompileRetries: z.number().required(),
  negativeStreakLimit: z.number().required(),
  convergenceThreshold: z.number().required(),
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

export function apply(ctx: Context, config: Config): void {
  const path = join(config.workspace, '.canness', 'state.json')
  const policy: PolicyConfig = {
    maxIterations: config.maxIterations,
    maxCompileRetries: config.maxCompileRetries,
    negativeStreakLimit: config.negativeStreakLimit,
    convergenceThreshold: config.convergenceThreshold,
  }
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
      const state = loadState(path)
      if (config.host === '') return emptyHostReport(state.generationId)
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(config.workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) throw new Error('build_test_package first')
      const files = await connectSftp({
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey: readFileSync(config.privateKeyPath, 'utf8'),
      })
      const { report, state: next } = await runEvaluation({
        files,
        localPackageDir,
        generationId: state.generationId,
        inbox: config.inbox,
        outbox: config.outbox,
        timeoutMs: config.timeoutSec * 1000,
        intervalMs: config.pollIntervalMs,
        state,
        config: policy,
      })
      saveState(path, next)
      return report
    },
  }))
}
