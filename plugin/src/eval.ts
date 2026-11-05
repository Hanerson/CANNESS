import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { runEvaluation } from './eval-run.js'
import { loadState, saveState } from './state-file.js'
import { registerProbeCommand, type TcpDial } from './probe.js'
import { connectRemote, type SftpOptions } from './ssh2-transport.js'
import type { RemoteHost } from './remote.js'
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

async function withRemoteHost<T>(
  ctx: Context,
  connect: (opts: SftpOptions) => Promise<RemoteHost>,
  cfg: ReturnType<typeof snapshot>,
  run: (files: RemoteHost) => Promise<T>,
): Promise<T> {
  const auth = await resolveAuth(ctx, cfg)
  if (auth.privateKey === undefined && auth.password === undefined) throw new Error('ssh credentials missing')
  const files = await connect({ host: cfg.host, port: cfg.port, username: cfg.username, ...auth })
  try {
    return await run(files)
  } finally {
    await files.close()
  }
}

/** Resolve a caller-supplied local path and keep it inside the workspace. */
function localTargetFor(workspace: string, remotePath: string, localPath: string | undefined): string {
  const root = resolve(workspace)
  const relativePath = localPath !== undefined && localPath.trim() !== ''
    ? localPath.trim()
    : join('remote-files', posix.basename(remotePath))
  const target = resolve(root, relativePath)
  const check = relative(root, target)
  if (check.startsWith('..') || isAbsolute(check)) {
    throw new Error('localPath must stay inside the workspace')
  }
  return target
}

/** The tool result: the report plus the three paths an agent would otherwise guess (i4). */
type RunEvaluationValue = EvalReport & {
  workspace: string
  packageDir: string | null
  resultsPath: string | null
}

function withPaths(
  report: EvalReport,
  workspace: string,
  generationId: string | null,
  outbox: string,
): RunEvaluationValue {
  return {
    ...report,
    workspace,
    packageDir: generationId === null ? null : join(workspace, 'packages', generationId),
    resultsPath: generationId === null ? null : posix.join(outbox, generationId, 'results.json'),
  }
}

export function apply(
  ctx: Context,
  config: Config,
  connect: (opts: SftpOptions) => Promise<RemoteHost> = connectRemote,
  dial?: TcpDial,
): void {
  if (dial === undefined) registerProbeCommand(ctx)
  else registerProbeCommand(ctx, dial)
  const statePath = join(config.workspace, '.canness', 'state.json')
  const workspace = resolve(config.workspace)
  ctx.tools.register(defineTool({
    name: 'run_evaluation',
    description: [
      'Upload the current test package and evaluate it on the remote NPU host.',
      'Call order is fixed: submit_spec -> write_operator -> build_test_package -> run_evaluation;',
      'run_evaluation requires the package that build_test_package wrote under packages/<generationId>.',
      `It uploads ${workspace}/packages/<generationId> to <inbox>/<generationId> over SSH exec (base64 tar, no SFTP),`,
      'then on the remote host runs the package\'s build.sh, its run_once.sh, and the real msprof',
      '(100 iterations, CSV under mindstudio_profiler_output/), and reads <outbox>/<generationId>/results.json.',
      'Nothing is compiled locally: this Windows side has no CANN toolchain.',
      'A missing build.sh/run_once.sh is reported as compile_fail with "package does not implement build contract v1".',
      'The result always carries workspace, packageDir and resultsPath, plus status / compile.log /',
      'correctness.maxRelativeError / performance.kernelTimeUs / analysis / summary.',
    ].join(' '),
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
            properties: {
              ok: { type: 'boolean', required: true },
              log: { type: 'string', required: true },
            },
          },
          correctness: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              maxRelativeError: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
            },
          },
          performance: {
            type: 'object',
            additionalProperties: false,
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
                  source: { type: 'string', required: true, enum: ['msprof'] },
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
          runRecord: {
            type: 'object',
            additionalProperties: false,
            properties: {
              timestamp: { type: 'string', required: true },
              host: { type: 'string', required: true },
              params: { type: 'json', required: true },
              toolchain: { type: 'string', required: true },
              durationMs: { type: 'number', required: true },
            },
          },
          summary: { type: 'string', required: true },
          workspace: { type: 'string', required: true },
          packageDir: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          resultsPath: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const cfg = snapshot(config)
      const state = loadState(statePath)
      const fail = (report: EvalReport): RunEvaluationValue => withPaths(report, workspace, state.generationId, cfg.outbox)
      if (cfg.host === '') return fail(emptyHostReport(state.generationId))
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(config.workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) throw new Error('build_test_package first')
      const reason = stopReason(state, policyOf(config))
      if (reason) return fail(stoppedReport(state.generationId, reason))
      const auth = await resolveAuth(ctx, cfg)
      if (auth.privateKey === undefined && auth.password === undefined) {
        return fail(missingCredentialsReport(state.generationId))
      }
      let files: RemoteHost
      try {
        files = await connect({ host: cfg.host, port: cfg.port, username: cfg.username, ...auth })
      } catch (error) {
        return fail(connectFailedReport(state.generationId, error instanceof Error ? error.message : 'unknown'))
      }
      let closed = false
      const close = async () => {
        if (closed) return
        closed = true
        await files.close()
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
        saveState(statePath, next)
        return fail(report)
      } finally {
        await close()
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'fetch_remote_file',
    description: [
      'Copy one file from the remote NPU host into the local workspace over SSH exec + base64 (no SFTP).',
      'Use it to pull msprof CSVs or runner logs back after run_evaluation; for example',
      'remotePath="/tmp/canness-a/outbox/<generationId>/results.json" and localPath="results/<generationId>.json".',
      'localPath is relative to the workspace; it defaults to remote-files/<basename>.',
    ].join(' '),
    parameters: {
      remotePath: { type: 'string', required: true, description: 'Absolute path on the remote host.' },
      localPath: { type: 'string', description: 'Workspace-relative destination; defaults to remote-files/<basename>.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const cfg = snapshot(config)
      if (cfg.host === '') throw new Error('ssh host is empty')
      const target = localTargetFor(config.workspace, args.remotePath, args.localPath)
      const body = await withRemoteHost(ctx, connect, cfg, async files => files.readFile(args.remotePath))
      if (body === null) throw new Error(`remote file not found: ${args.remotePath}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      return { path: target, bytes: body.length }
    },
  }))
}
