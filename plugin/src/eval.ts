import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
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
import { canForceEvaluation, stopReason, targetGap, type PolicyConfig, type StopReason, type TaskState } from './policy.js'
import { resolveWorkspace, statePath } from './workspace.js'
import { checkGolden, checkKernel } from './local-validation.js'
import { validateSubmission } from './submission-validation.js'
import { assertTaskOwnership, claimTaskOwnership } from './task-ownership.js'

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
  /** Explicit additional read-only remote roots. Empty by default. */
  readRoots?: Volatile<string[]>
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
  readRoots: z.array(z.string()).default([]).volatile(),
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
    readRoots: config.readRoots?.get?.() ?? [],
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
  let parent = dirname(target)
  while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
  const realRoot = existsSync(root) ? realpathSync(root) : root
  const realParent = realpathSync(parent)
  const actual = relative(realRoot, realParent)
  if (actual.startsWith('..') || isAbsolute(actual) || existsSync(target) && statSync(target).isDirectory()) {
    throw new Error('localPath must stay inside the workspace')
  }
  let destinationStat
  try { destinationStat = lstatSync(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (destinationStat?.isSymbolicLink()) throw new Error('localPath must stay inside the workspace: symlink destinations are not allowed')
  if (destinationStat) {
    const realTarget = relative(realRoot, realpathSync(target))
    if (realTarget.startsWith('..') || isAbsolute(realTarget)) throw new Error('localPath must stay inside the workspace')
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
  readRoots: readonly string[] = [],
  knownGenerations: readonly string[] = [],
): boolean {
  if (!posix.isAbsolute(remotePath)) return false
  const target = posix.normalize(remotePath)
  const within = (root: string): boolean => {
    const base = posix.normalize(root)
    return target === base || target.startsWith(base.endsWith('/') ? base : `${base}/`)
  }
  if (posix.isAbsolute(outbox) && within(outbox)) return true
  if (readRoots.some(root => posix.isAbsolute(root) && posix.normalize(root) !== '/' && within(root))) return true
  return [generationId, ...knownGenerations].some(id => id !== null && /^gen-[A-Za-z0-9-]+$/.test(id)
    && within(posix.join(inbox, id)))
}

/** The tool result: the report plus the three paths an agent would otherwise guess (i4). */
type RunEvaluationValue = EvalReport & {
  workspace: string
  packageDir: string | null
  resultsPath: string | null
  pendingStage: 'run_evaluation' | null
  compileOnly?: boolean
  artifactsPersistent?: boolean
  artifactWarning?: string
}

function withPaths(
  report: EvalReport,
  workspace: string,
  generationId: string | null,
  outbox: string,
  pendingStage: RunEvaluationValue['pendingStage'] = null,
  hasResult = false,
  inbox?: string,
): RunEvaluationValue {
  return {
    ...report,
    workspace,
    packageDir: generationId === null ? null : join(workspace, 'packages', generationId),
    resultsPath: hasResult && generationId !== null ? posix.join(outbox, generationId, 'results.json') : null,
    pendingStage,
    artifactsPersistent: ![outbox, inbox ?? outbox].some(path => /^\/(?:tmp|var\/tmp)(?:\/|$)/.test(path)),
    ...([outbox, inbox ?? outbox].some(path => /^\/(?:tmp|var\/tmp)(?:\/|$)/.test(path))
      ? { artifactWarning: 'Remote artifacts are in a temporary directory. Configure inbox/outbox under a persistent mount such as /mnt/workspace on CANNLab.' } : {}),
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
      compile_only: { type: 'boolean', description: 'Diagnostic build only. Does not run accuracy/msprof, consume evaluation budgets, or overwrite the last evaluation result.' },
      golden_fixtures: { type: 'string', description: 'Optional workspace-relative reference vector JSON. A failing local golden check prevents remote execution without spending budget.' },
      kernel_dtypes: { type: 'array', items: { type: 'string' }, description: 'Optional dtype variants for limited local host-stub kernel syntax lint before SSH. Does not validate target API support.' },
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
                  notCollected: { type: 'array', items: { type: 'string' } },
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
                          blockDimSource: { oneOf: [{ type: 'string', enum: ['msprof', 'launch-config'] }, { type: 'null' }] },
                          kernelTaskType: { oneOf: [{ type: 'string', enum: ['AIV', 'AIC'] }, { type: 'null' }] },
                          kernelTaskTypeSource: { oneOf: [{ type: 'string' }, { type: 'null' }] },
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
          compileOnly: { type: 'boolean' },
          blockedBy: { type: 'string', enum: ['policy', 'transport', 'ownership', 'validation'] },
          budget: { type: 'json' },
          ownerSession: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          stopReason: { type: 'string' },
          policyEvidence: { type: 'json' },
          artifactsPersistent: { type: 'boolean' },
          artifactWarning: { type: 'string' },
          localGolden: { type: 'json' },
          localKernel: { type: 'json' },
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
      const compileOnly = (_args as { compile_only?: boolean } | null)?.compile_only === true
      const cfg = snapshot(config)
      const workspace = resolveWorkspace(config.workspace, exec)
      const stateFile = statePath(workspace)
      let state = loadState(stateFile)
      // The first evaluation claims the task for this session. Without an
      // owner the loop stays quiet, which is what keeps one session's failure
      // from driving every other session in the profile.
      const owner = exec?.agent?.session?.id
      const budget = { ...policyOf(config), validIterations: state.validIterations, compileRetries: state.compileRetries,
        timeouts: state.timeouts, windowStartedAt: state.budgetWindowStartedAt ?? null }
      const observed = (report: EvalReport): EvalReport => ({ ...report, budget, ownerSession: state.ownerSessionId ?? owner ?? null })
      const rejected = (report: EvalReport): EvalReport => {
        const latest = loadState(stateFile)
        if (latest.generationId === state.generationId && state.generationId !== null) saveState(stateFile, {
          ...latest, lastBlocked: { reason: report.summary, at: new Date().toISOString(), session: owner ?? null,
            blockedBy: report.blockedBy, budget },
        })
        return observed(report)
      }
      try { assertTaskOwnership(stateFile, 'run_evaluation', exec) } catch (error) {
        return withPaths(observed({ ...unavailableReport(state.generationId, errorMessage(error)), blockedBy: 'ownership' }),
          workspace, state.generationId, cfg.outbox, null)
      }
      if (!compileOnly && state.generationId !== null) {
        state = claimTaskOwnership(stateFile, 'run_evaluation', exec)
        budget.windowStartedAt = state.budgetWindowStartedAt ?? null
      }
      const fail = (report: EvalReport): RunEvaluationValue =>
        withPaths(rejected(report), workspace, state.generationId, cfg.outbox, state.pendingStage ?? null)
      if (state.generationId === null && cfg.host === '') return fail(unavailableReport(null, 'ssh host is empty'))
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) {
        if (cfg.host === '') return fail(unavailableReport(state.generationId, 'ssh host is empty'))
        throw new Error('build_test_package first')
      }
      const currentHash = checkPackageHash(localPackageDir, state)
      const kernelDtypes = (_args as { kernel_dtypes?: string[] } | null)?.kernel_dtypes
      if (kernelDtypes) {
        const localKernel = await checkKernel(localPackageDir, kernelDtypes)
        if (localKernel === null || typeof localKernel !== 'object' || Array.isArray(localKernel) || localKernel.status !== 'pass') {
          return { ...withPaths(rejected({ ...unavailableReport(state.generationId, 'local host-stub kernel syntax check failed; this is not target compiler validation; inspect the local diagnostics; no remote budget spent'), blockedBy: 'validation' }), workspace, state.generationId, cfg.outbox), localKernel }
        }
      }
      const fixturePath = (_args as { golden_fixtures?: string } | null)?.golden_fixtures
      if (!compileOnly && fixturePath) {
        const localGolden = await checkGolden(localPackageDir, localTargetFor(workspace, 'golden-fixtures.json', fixturePath))
        if (localGolden === null || typeof localGolden !== 'object' || Array.isArray(localGolden) || localGolden.status !== 'pass') {
          return { ...withPaths(rejected({ ...unavailableReport(state.generationId, 'local golden validation failed; no remote budget spent'), blockedBy: 'validation' }), workspace, state.generationId, cfg.outbox), localGolden }
        }
      }
      if (state.lastEvaluatedHash === currentHash && state.lastReport !== null && state.pendingStage == null && !force && !compileOnly) {
        saveState(stateFile, { ...state, pendingSteer: false })
        return withPaths(observed({
          ...state.lastReport,
          duplicate: true,
          summary: `duplicate package: same content as the last evaluation; previous result: ${state.lastReport.summary}`,
        }), workspace, state.generationId, cfg.outbox, null, state.lastReport.status !== 'timeout', cfg.inbox)
      }
      const reason = stopReason(state, policyOf(config))
      const forcedAfterStop = force && canForceEvaluation(state, policyOf(config))
      if (reason && !compileOnly && !forcedAfterStop) {
        saveState(stateFile, { ...state, lastBlocked: { reason, at: new Date().toISOString(), session: owner ?? null, blockedBy: 'policy', budget } })
        return withPaths(observed({
        ...stoppedReport(state.generationId, stoppedSummary(state, reason)), blockedBy: 'policy', stopReason: reason,
        policyEvidence: { recentKernelTimeUs: state.recentKernelTimeUs ?? [], negativeStreak: state.negativeStreak,
          forcedRunsAfterStop: state.forcedRunsAfterStop ?? 0, packageHash: currentHash },
        }), workspace, state.generationId, cfg.outbox, null)
      }
      if (!compileOnly && (state.pendingStage == null || state.pendingSteer)) {
        saveState(stateFile, { ...state, pendingStage: 'run_evaluation', pendingSteer: false })
      }
      const pending = (summary: string): RunEvaluationValue => withPaths(
        rejected({ ...unavailableReport(state.generationId, summary), blockedBy: 'transport' }), workspace, state.generationId, cfg.outbox, compileOnly ? null : 'run_evaluation',
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
        state: { ...state, packageHash: currentHash },
        force,
        compileOnly,
        config: policyOf(config),
      }).catch(
        error => `remote evaluation interrupted: ${errorMessage(error)}. Check the remote host and rerun run_evaluation.`,
      ).finally(() => files.close().catch(() => {}))
      if (typeof outcome === 'string') return pending(outcome)
      const { report, state: next, resultWritten, resultGenerationId } = outcome
      if (report.status === 'error' && !resultWritten) return pending(report.summary)
      if (force && report.runRecord !== undefined) report.runRecord.params.forced = true
      if (compileOnly) return { ...withPaths(report, workspace, resultGenerationId ?? state.generationId, cfg.outbox, null, resultWritten),
        packageDir: localPackageDir, compileOnly: true }
      const latest = loadState(stateFile)
      if (latest.generationId === state.generationId && latest.packageHash === state.packageHash) {
        saveState(stateFile, {
          ...next,
          // Legacy hand-built packages do not acquire a build fingerprint by measurement.
          packageHash: state.packageHash ?? null,
          forcedRunsAfterStop: (state.forcedRunsAfterStop ?? 0) + (forcedAfterStop ? 1 : 0),
          pendingStage: null,
          lastEvaluatedHash: currentHash,
          ownerSessionId: owner ?? state.ownerSessionId ?? null,
          // One retry is owed for this report, and only for it.
          pendingSteer: !forcedAfterStop,
          steerCount: 0,
          lastSteerAt: 0,
        })
      }
      return withPaths(observed(report), workspace, state.generationId, cfg.outbox, null, resultWritten, cfg.inbox)
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
      golden_fixtures: { type: 'string', description: 'Optional workspace-relative reference vector JSON for compiling and checking the real golden locally.' },
      kernel_dtypes: { type: 'array', items: { type: 'string' }, description: 'Optional dtype variants for limited host-stub kernel syntax lint. No NPU connection required.' },
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
      let localChecks: JsonValue = args.golden_fixtures && packageDir
        ? { ...local, golden: await checkGolden(packageDir, localTargetFor(workspace, 'golden-fixtures.json', args.golden_fixtures)) }
        : local
      if (args.kernel_dtypes && packageDir) localChecks = { ...localChecks as Record<string, JsonValue>, kernel: await checkKernel(packageDir, args.kernel_dtypes) }
      if (localChecks !== null && typeof localChecks === 'object' && !Array.isArray(localChecks)) {
        const checks = [localChecks.golden, localChecks.kernel].filter(value => value !== undefined)
        if (checks.some(value => value === null || typeof value !== 'object' || Array.isArray(value) || value.status !== 'pass')) localChecks.ok = false
      }
      const base = {
        generationId: state.generationId, workspace, packageDir, local: localChecks, pendingStage: state.pendingStage ?? null,
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
      'or known historical generation inbox plus explicitly configured readRoots. Symlink escapes are rejected.',
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
          sha256: { type: 'string', required: true },
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
      const known = ['operators', 'packages'].flatMap(dir => {
        const path = join(workspace, dir)
        return existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : []
      })
      if (!remoteTargetAllowed(args.remotePath, cfg.outbox, cfg.inbox, state.generationId, cfg.readRoots, known)) {
        throw new Error('remotePath is outside the allowed remote directories (outbox and inbox/<generationId>)')
      }
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      if ('summary' in connection) throw new Error(connection.summary)
      const { files } = connection
      const roots = [cfg.outbox, ...[state.generationId, ...known].filter((id): id is string => id !== null && /^gen-[A-Za-z0-9-]+$/.test(id)).map(id => posix.join(cfg.inbox, id)), ...cfg.readRoots]
      const body = await (async () => {
        if (!files.readFileWithin) throw new Error('remote transport does not support confined reads')
        return files.readFileWithin(args.remotePath, roots, 8 * 1024 * 1024)
      })().finally(() => files.close().catch(() => {}))
      if (body === null) throw new Error(`remote file not found: ${args.remotePath}`)
      mkdirSync(dirname(target), { recursive: true })
      // Replace the destination entry atomically instead of following a link
      // introduced between validation and the write.
      const temporary = join(dirname(target), `.canness-fetch-${randomUUID()}.tmp`)
      writeFileSync(temporary, body, { flag: 'wx' })
      renameSync(temporary, target)
      return { path: target, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'validate_submission',
    description: 'Validate an exported source tree independently of evaluation budgets: verify hashes, build a wheel remotely, install into an isolated venv and optionally execute a task-specific golden comparator. Without a comparator correctness remains unverified. Never installs into the global Python environment.',
    parameters: {
      source_dir: { type: 'string', required: true, description: 'Exported source directory inside the workspace, containing provenance.json.' },
      test_script: { type: 'string', description: 'Complete Python comparator. Must emit exactly one CANNESS_VALIDATION JSON with ok:true after checking installed callable against an independent reference.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec?: ToolAgentContext) {
      const workspace = resolveWorkspace(config.workspace, exec)
      const source = resolve(workspace, args.source_dir)
      const relativeSource = relative(realpathSync(workspace), realpathSync(source))
      if (relativeSource.startsWith('..') || isAbsolute(relativeSource)) throw new Error('source_dir must stay inside the workspace')
      const cfg = snapshot(config)
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      if ('summary' in connection) return { status: 'failed', correctness: 'unverified', reason: connection.summary }
      try {
        return await validateSubmission(connection.files, { sourceDir: source, remoteRoot: cfg.inbox,
          setEnv: cfg.setEnv, testScript: args.test_script, timeoutSec: cfg.timeoutSec })
      } finally { await connection.files.close().catch(() => {}) }
    },
  }))
}
