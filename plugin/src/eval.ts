import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { preflightToolchain, runEvaluation } from './eval-run.js'
import { loadState, saveState } from './state-file.js'
import { registerProbeCommand, type TcpDial } from './probe.js'
import { connectRemote, type SftpOptions } from './ssh2-transport.js'
import { packageHash } from './package-files.js'
import { describeTunnelFailure, renewTunnel, tunnelHealth, usesCurrentTunnel } from './cannlab/connect.js'
import { DEFAULT_TOKEN_REF } from './cannlab/constants.js'
import { createTokenStore } from './cannlab/tokens.js'
import type { RemoteHost } from './remote.js'
import { stoppedReport, type EvalReport, type JsonValue } from './report.js'
import { stopReason, targetGap, type PolicyConfig, type StopReason, type TaskState } from './policy.js'
import { resolveWorkspace, statePath } from './workspace.js'

export const name = 'canness-eval'
export const inject = ['tools']

/** The slice of a tool run context this plugin reads: who is calling. */
interface ToolAgentContext {
  agent?: { session?: { id?: string } }
}

// Every field the settings card edits must be volatile: the dsh settings
// service refuses writes to non-volatile paths, and volatile references are
// re-read per operation so a card save takes effect without a remount.
export interface Config {
  workspace?: string
  host: Volatile<string>
  port: Volatile<number>
  username: Volatile<string>
  privateKeyPath: Volatile<string>
  passwordEnv: Volatile<string>
  inbox: Volatile<string>
  outbox: Volatile<string>
  timeoutSec: Volatile<number>
  pollIntervalMs: Volatile<number>
  /** Empty means the remote runner auto-detects CANN's set_env.sh. */
  setEnv: Volatile<string>
  maxIterations: Volatile<number>
  maxCompileRetries: Volatile<number>
  negativeStreakLimit: Volatile<number>
  convergenceThreshold: Volatile<number>
  /** Rounds without real gain that stop the loop with a human decision. */
  stallRounds: Volatile<number>
  /** Smallest relative improvement that still counts as progress. */
  stallGain: Volatile<number>
  /** Gap to target at which a stall is worth a human decision. */
  stallGap: Volatile<number>
}

export const Config = z.object({
  workspace: z.string().default(''),
  host: z.string().required().volatile(),
  port: z.number().required().volatile(),
  username: z.string().required().volatile(),
  privateKeyPath: z.string().required().volatile(),
  passwordEnv: z.string().role('credential-ref').default('CANNNESS_SSH_PASSWORD').volatile(),
  inbox: z.string().required().volatile(),
  outbox: z.string().required().volatile(),
  timeoutSec: z.number().required().volatile(),
  pollIntervalMs: z.number().required().volatile(),
  setEnv: z.string().default('').volatile(),
  maxIterations: z.number().required().volatile(),
  maxCompileRetries: z.number().required().volatile(),
  negativeStreakLimit: z.number().required().volatile(),
  convergenceThreshold: z.number().required().volatile(),
  // Defaults keep an existing profile row working without the three new keys.
  stallRounds: z.number().default(2).volatile(),
  stallGain: z.number().default(0.03).volatile(),
  stallGap: z.number().default(1.5).volatile(),
})

function unavailableReport(generationId: string | null, summary: string): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary,
  }
}

/**
 * How `run_evaluation` asks about the CANNLab forward. Tests inject this so a
 * dead tunnel is reachable without a real helper process.
 */
export interface TunnelProbe {
  matches(host: string, port: number): boolean
  health(): Promise<'up' | 'down' | 'none'>
  renew(): Promise<boolean>
  describeFailure?(host: string, port: number, keyPath: string, ctx: Context): Promise<string | null>
}

const defaultTunnelProbe: TunnelProbe = {
  matches: usesCurrentTunnel,
  health: tunnelHealth,
  renew: renewTunnel,
  describeFailure: (host, port, keyPath, ctx) => describeTunnelFailure(
    host, port, keyPath, () => createTokenStore(ctx, DEFAULT_TOKEN_REF),
  ),
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
    setEnv: config.setEnv?.get?.() ?? '',
  }
}

/**
 * A volatile number, tolerating a config object that predates the key.
 * @param value - the config field, present only once the schema gained it.
 * @param fallback - policy default.
 * @returns the configured number or the fallback.
 */
function numberOf(value: { get(): number } | undefined, fallback: number): number {
  return typeof value?.get === 'function' ? value.get() : fallback
}

function policyOf(config: Config): PolicyConfig {
  return {
    maxIterations: config.maxIterations.get(),
    maxCompileRetries: config.maxCompileRetries.get(),
    negativeStreakLimit: config.negativeStreakLimit.get(),
    convergenceThreshold: config.convergenceThreshold.get(),
    stallRounds: numberOf(config.stallRounds, 2),
    stallGain: numberOf(config.stallGain, 0.03),
    stallGap: numberOf(config.stallGap, 1.5),
  }
}

/**
 * The stop sentence a human reads through the tool result.
 *
 * A stall is not the same event as a spent budget: the loop did not run out of
 * attempts, it ran out of ideas, so the message has to say what the decision is
 * instead of implying another tweak will do.
 * @param state - the fold that produced the stop.
 * @param reason - the stop condition that fired.
 * @returns the report summary.
 */
function stoppedSummary(state: TaskState, reason: StopReason): string {
  if (reason !== 'stalled') return reason
  const gap = targetGap(state)
  const recent = (state.recentKernelTimeUs ?? []).slice(-3)
  const trend = recent.map(value => `${value.toFixed(1)}us`).join(' → ')
  const distance = gap === null ? '' : `，仍差 ${gap.toFixed(2)} 倍`
  return `stalled${distance}: no real gain over the last ${String(recent.length)} rounds (${trend}). `
    + 'Stop tuning. Decide one of: change the algorithm, relax the target deliberately in a new spec with a reason, or stop the task.'
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

type RemoteConnection = { files: RemoteHost } | { summary: string }

async function openEvaluationRemote(
  ctx: Context,
  connect: (opts: SftpOptions) => Promise<RemoteHost>,
  cfg: ReturnType<typeof snapshot>,
  tunnel: TunnelProbe,
): Promise<RemoteConnection> {
  if (cfg.host === '') return { summary: 'ssh host is empty' }
  const endpoint = `${cfg.host}:${cfg.port}`
  const hint = async (): Promise<string | null> =>
    await tunnel.describeFailure?.(cfg.host, cfg.port, cfg.privateKeyPath, ctx).catch(() => null) ?? null
  let auth: Awaited<ReturnType<typeof resolveAuth>>
  try {
    auth = await resolveAuth(ctx, cfg)
  } catch (error) {
    return { summary: `ssh credentials could not be read for ${endpoint}: ${errorMessage(error)}. Check Settings → CANNESS.` }
  }
  if (auth.privateKey === undefined && auth.password === undefined) return { summary: 'ssh credentials missing' }
  if (tunnel.matches(cfg.host, cfg.port)) {
    const health = await tunnel.health().catch(() => 'down' as const)
    if (health === 'down') {
      return { summary: `CANNLab tunnel ${endpoint} is down. ${await hint() ?? 'Reconnect from Settings → CANNESS.'}` }
    }
    if (health === 'up') await tunnel.renew().catch(() => false)
  }
  try {
    return { files: await connect({ host: cfg.host, port: cfg.port, username: cfg.username, ...auth }) }
  } catch (error) {
    const detail = errorMessage(error)
    const diagnosed = await hint()
    return { summary: `ssh connect failed for ${endpoint}: ${detail}. ${diagnosed ?? 'Check the SSH endpoint and credentials in Settings → CANNESS.'}` }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

/** Return the current package fingerprint or reject edits made after packaging. */
function checkPackageHash(packageDir: string, state: TaskState): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as { packageHash?: string }
  const hash = packageHash(packageDir)
  if ((manifest.packageHash !== undefined && manifest.packageHash !== hash)
      || (state.packageHash != null && state.packageHash !== hash)) {
    throw new Error('package changed after build_test_package; rebuild the package before evaluation')
  }
  return hash
}

function inspectLocalPackage(packageDir: string | null, state: TaskState): { ok: boolean; issues: string[] } {
  if (packageDir === null) return { ok: false, issues: ['submit_spec first'] }
  if (!existsSync(packageDir)) return { ok: false, issues: ['build_test_package first'] }
  const issues = ['manifest.json', 'config.json', 'build.sh', 'run_once.sh', 'main.cpp', 'golden.h']
    .filter(name => !statSync(join(packageDir, name), { throwIfNoEntry: false })?.isFile())
    .map(name => `missing ${name}`)
  try {
    if (!issues.includes('missing manifest.json')) checkPackageHash(packageDir, state)
    if (!issues.includes('missing config.json')) JSON.parse(readFileSync(join(packageDir, 'config.json'), 'utf8'))
    if (!issues.includes('missing golden.h') && /^\s*#\s*define\s+CANNESS_GOLDEN_PLACEHOLDER\b/mu
      .test(readFileSync(join(packageDir, 'golden.h'), 'utf8'))) {
      issues.push('golden not implemented; write golden.h using write_package_file and rebuild')
    }
  } catch (error) {
    issues.push(errorMessage(error))
  }
  return { ok: issues.length === 0, issues }
}

interface PreflightValue {
  generationId: string | null
  workspace: string
  packageDir: string | null
  pendingStage: 'run_evaluation' | null
  local: JsonValue
  remote: JsonValue
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

/**
 * Remote reads are confined to the configured outbox and the current
 * generation's inbox. Anything else (keys, /etc, a sibling generation) is
 * rejected before the transport sees it.
 */
export function remoteTargetAllowed(
  remotePath: string,
  outbox: string,
  inbox: string,
  generationId: string | null,
): boolean {
  if (!posix.isAbsolute(remotePath)) return false
  const target = posix.normalize(remotePath)
  const within = (root: string): boolean => {
    const base = posix.normalize(root)
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
  }
  if (within(outbox)) return true
  return generationId !== null && within(posix.join(inbox, generationId))
}

/** The tool result: the report plus the three paths an agent would otherwise guess (i4). */
type RunEvaluationValue = EvalReport & {
  workspace: string
  packageDir: string | null
  resultsPath: string | null
  pendingStage: 'run_evaluation' | null
}

function withPaths(
  report: EvalReport,
  workspace: string,
  generationId: string | null,
  outbox: string,
  pendingStage: RunEvaluationValue['pendingStage'] = null,
  hasResult = false,
): RunEvaluationValue {
  return {
    ...report,
    workspace,
    packageDir: generationId === null ? null : join(workspace, 'packages', generationId),
    resultsPath: hasResult && generationId !== null ? posix.join(outbox, generationId, 'results.json') : null,
    pendingStage,
  }
}

export function apply(
  ctx: Context,
  config: Config,
  connect: (opts: SftpOptions) => Promise<RemoteHost> = connectRemote,
  dial?: TcpDial,
  tunnel: TunnelProbe = defaultTunnelProbe,
): void {
  if (dial === undefined) registerProbeCommand(ctx)
  else registerProbeCommand(ctx, dial)
  ctx.tools.register(defineTool({
    name: 'run_evaluation',
    description: [
      'Upload the current test package and evaluate it on the remote NPU host.',
      'Call order is fixed: submit_spec -> write_operator -> build_test_package -> run_evaluation;',
      'run_evaluation requires the package that build_test_package wrote under packages/<generationId>.',
      'It uploads workspace/packages/<generationId> to <inbox>/<generationId> over SSH exec (base64 tar, no SFTP),',
      'then on the remote host runs the package\'s build.sh, its run_once.sh, and the real msprof',
      '(CSV under mindstudio_profiler_output/), and reads <outbox>/<generationId>/results.json.',
      'Nothing is compiled locally: this Windows side has no CANN toolchain.',
      'A missing build.sh/run_once.sh is reported as compile_fail with "package does not implement build contract v1".',
      'A placeholder golden.h (write_package_file) returns accuracy_fail with "golden not implemented", never pass.',
      'An unchanged package returns the previous report with duplicate:true without connecting; use force:true to remeasure.',
      'The result always carries workspace, packageDir and resultsPath, plus status / compile.log /',
      'correctness.maxRelativeError / performance.kernelTimeUs / analysis / summary.',
      'Connection and transport failures leave pendingStage:run_evaluation. Restore the connection and retry the same package.',
    ].join(' '),
    parameters: {
      force: { type: 'boolean', description: 'Remeasure an unchanged package; recorded in runRecord.params.forced.' },
    },
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
                  achievedBandwidthGBps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  rooflineUs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  baselineUs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
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
          duplicate: { type: 'boolean' },
          workspace: { type: 'string', required: true },
          packageDir: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          resultsPath: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          pendingStage: { required: true, oneOf: [{ type: 'string', enum: ['run_evaluation'] }, { type: 'null' }] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: unknown, exec?: ToolAgentContext) {
      const force = (_args as { force?: boolean } | null)?.force === true
      const cfg = snapshot(config)
      const workspace = resolveWorkspace(config.workspace, exec)
      const stateFile = statePath(workspace)
      const state = loadState(stateFile)
      // The first evaluation claims the task for this session. Without an
      // owner the loop stays quiet, which is what keeps one session's failure
      // from driving every other session in the profile.
      const owner = exec?.agent?.session?.id
      const fail = (report: EvalReport): RunEvaluationValue =>
        withPaths(report, workspace, state.generationId, cfg.outbox, state.pendingStage ?? null)
      if (state.generationId === null && cfg.host === '') return fail(unavailableReport(null, 'ssh host is empty'))
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) {
        if (cfg.host === '') return fail(unavailableReport(state.generationId, 'ssh host is empty'))
        throw new Error('build_test_package first')
      }
      const currentHash = checkPackageHash(localPackageDir, state)
      if (state.lastEvaluatedHash === currentHash && state.lastReport !== null && state.pendingStage == null && !force) {
        saveState(stateFile, { ...state, pendingSteer: false })
        return withPaths({
          ...state.lastReport,
          duplicate: true,
          summary: `duplicate package: same content as the last evaluation; previous result: ${state.lastReport.summary}`,
        }, workspace, state.generationId, cfg.outbox, null, state.lastReport.status !== 'timeout')
      }
      const reason = stopReason(state, policyOf(config))
      if (reason) return fail(stoppedReport(state.generationId, stoppedSummary(state, reason)))
      if (state.pendingStage == null || state.pendingSteer) {
        saveState(stateFile, { ...state, pendingStage: 'run_evaluation', pendingSteer: false })
      }
      const pending = (summary: string): RunEvaluationValue => withPaths(
        unavailableReport(state.generationId, summary), workspace, state.generationId, cfg.outbox, 'run_evaluation',
      )
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      if ('summary' in connection) return pending(connection.summary)
      const { files } = connection
      const outcome = await runEvaluation({
        files,
        localPackageDir,
        generationId: state.generationId,
        inbox: cfg.inbox,
        outbox: cfg.outbox,
        timeoutMs: cfg.timeoutSec * 1000,
        intervalMs: cfg.pollIntervalMs,
        setEnv: cfg.setEnv,
        state,
        config: policyOf(config),
      }).catch(
        error => `remote evaluation interrupted: ${errorMessage(error)}. Check the remote host and rerun run_evaluation.`,
      ).finally(() => files.close().catch(() => {}))
      if (typeof outcome === 'string') return pending(outcome)
      const { report, state: next, resultWritten } = outcome
      if (report.status === 'error' && !resultWritten) return pending(report.summary)
      if (force && report.runRecord !== undefined) report.runRecord.params.forced = true
      const latest = loadState(stateFile)
      if (latest.generationId === state.generationId && latest.packageHash === state.packageHash) {
        saveState(stateFile, {
          ...next,
          pendingStage: null,
          lastEvaluatedHash: currentHash,
          ownerSessionId: owner ?? state.ownerSessionId ?? null,
          // One retry is owed for this report, and only for it.
          pendingSteer: true,
          steerCount: 0,
          lastSteerAt: 0,
        })
      }
      return withPaths(report, workspace, state.generationId, cfg.outbox, null, resultWritten)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'preflight_evaluation',
    description: [
      'Check the current local package without compiling or consuming an evaluation attempt.',
      'Pass remote:true to also check SSH and the CANN compiler, version, and profiler on the NPU host.',
      'Use run_evaluation to resume a pending stage after fixing connectivity. Check CANNLab quota in the CANNLab console.',
    ].join(' '),
    parameters: {
      remote: { type: 'boolean', description: 'Check the SSH endpoint and CANN toolchain as well as package files.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          workspace: { type: 'string', required: true },
          packageDir: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          pendingStage: { required: true, oneOf: [{ type: 'string', enum: ['run_evaluation'] }, { type: 'null' }] },
          local: { type: 'json', required: true },
          remote: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec?: ToolAgentContext): Promise<PreflightValue> {
      const workspace = resolveWorkspace(config.workspace, exec)
      const state = loadState(statePath(workspace))
      const packageDir = state.generationId === null ? null : join(workspace, 'packages', state.generationId)
      const local = inspectLocalPackage(packageDir, state)
      const base = {
        generationId: state.generationId, workspace, packageDir, local, pendingStage: state.pendingStage ?? null,
      }
      if (!args.remote) return { ...base, remote: null }
      const cfg = snapshot(config)
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      const endpoint = `${cfg.host}:${cfg.port}`
      const quota = 'Check available quota in the CANNLab console if using a CANNLab environment.'
      if ('summary' in connection) {
        return { ...base, remote: { endpoint, ssh: 'unavailable', summary: connection.summary, quota } }
      }
      const { files } = connection
      try {
        const cann = await preflightToolchain(files, cfg.setEnv)
        return { ...base, remote: { endpoint, ssh: 'connected', cann, quota } }
      } catch (error) {
        return { ...base, remote: { endpoint, ssh: 'connected', cann: { ready: false, error: errorMessage(error) }, quota } }
      } finally {
        await files.close().catch(() => {})
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'fetch_remote_file',
    description: [
      'Copy one file from the remote NPU host into the local workspace over SSH exec + base64 (no SFTP).',
      'remotePath must be absolute; reads are limited to the configured outbox and the current',
      'generation\'s inbox — any other remote path is rejected before transmission.',
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
    async execute(args, exec?: ToolAgentContext) {
      const cfg = snapshot(config)
      if (cfg.host === '') throw new Error('ssh host is empty')
      const workspace = resolveWorkspace(config.workspace, exec)
      const target = localTargetFor(workspace, args.remotePath, args.localPath)
      if (!posix.isAbsolute(args.remotePath)) {
        throw new Error('remotePath must be an absolute POSIX path')
      }
      const state = loadState(statePath(workspace))
      if (!remoteTargetAllowed(args.remotePath, cfg.outbox, cfg.inbox, state.generationId)) {
        throw new Error('remotePath is outside the allowed remote directories (outbox and inbox/<generationId>)')
      }
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      if ('summary' in connection) throw new Error(connection.summary)
      const { files } = connection
      const body = await files.readFile(args.remotePath).finally(() => files.close().catch(() => {}))
      if (body === null) throw new Error(`remote file not found: ${args.remotePath}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, body)
      return { path: target, bytes: body.length }
    },
  }))
}
