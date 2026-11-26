import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
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
import { unverifiedSubmissionStages, validateSubmission } from './submission-validation.js'
import { assertTaskOwnership, claimTaskOwnership } from './task-ownership.js'
import { runIntrinsicProbe } from './intrinsic-probe.js'
import { parseProbeConclusion, recordProbeConclusion } from './probe-knowledge.js'
import { compareTargetPlatform, resolveSoc, type TargetPlatform } from './spec.js'

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
  /** Empty uses the remote runner default. */
  device?: Volatile<string>
  deviceLock?: Volatile<string>
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
  device: z.string().default('').volatile(),
  deviceLock: z.string().default('').volatile(),
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
    device: config.device?.get?.() ?? '',
    deviceLock: config.deviceLock?.get?.() ?? '',
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

/**
 * Return the current package fingerprint or reject edits made after packaging.
 *
 * `manifest.packageHash` is the single source of truth. `state.packageHash` is
 * only a cache of "which package was last evaluated" and must not authorize a
 * different package: a stale state entry used to block even `compile_only`
 * diagnostics (CAN-104). It is reported in the error text so the mismatch is
 * attributable at a glance.
 */
function checkPackageHash(packageDir: string, state: TaskState): string {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'manifest.json'), 'utf8')) as { packageHash?: string }
  const hash = packageHash(packageDir)
  if (manifest.packageHash !== undefined && manifest.packageHash !== hash) {
    throw new Error(`package changed after build_test_package: manifest=${manifest.packageHash}, `
      + `state=${state.packageHash ?? '<none>'}, actual=${hash}; rebuild the package or repair it before evaluation`)
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
  submission?: JsonValue
}

const submissionParameters = {
  source_dir: { type: 'string', required: true, description: 'Exported source directory inside the workspace, containing provenance.json.' },
  test_script: { type: 'string', description: 'Python comparator. Invoke the installed cann_bench public callable, synchronize and compare with an independent reference. Emit CANNESS_VALIDATION JSON with boolean ok and optional numeric mere and mare.' },
  cases_file: { type: 'string', description: 'Workspace CSV with a case_id column. Requires test_script. Each row is passed as CANNESS_CASE_JSON to a fresh Python process.' },
  case_timeout_sec: { type: 'number', description: 'Per-case timeout in seconds (default 120, bounded by the total validation timeout).' },
} as const

type SubmissionArgs = {
  source_dir: string
  test_script?: string
  cases_file?: string
  case_timeout_sec?: number
}

function workspaceInput(workspace: string, path: string, label: string): string {
  const absolute = resolve(workspace, path)
  const within = relative(realpathSync(workspace), realpathSync(absolute))
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error(`${label} must stay inside the workspace`)
  return absolute
}

function prepareSubmission(workspace: string, args: SubmissionArgs) {
  if (args.cases_file && !args.test_script?.trim()) throw new Error('cases_file requires a test_script')
  return {
    sourceDir: workspaceInput(workspace, args.source_dir, 'source_dir'),
    testScript: args.test_script,
    casesFile: args.cases_file ? workspaceInput(workspace, args.cases_file, 'cases_file') : undefined,
    caseTimeoutSec: args.case_timeout_sec,
  }
}

function targetComparison(platform: TargetPlatform, detectedSoc: string | undefined): JsonValue {
  const { declared, detected, ...comparison } = compareTargetPlatform(platform, detectedSoc)
  return { ...comparison, declared: declared ? { ...declared } : null, detected: detected ? { ...detected } : null }
}

function readSubmissionTarget(workspace: string, sourceDir: string) {
  const path = workspaceInput(workspace, join(sourceDir, 'provenance.json'), 'submission provenance')
  const selected = JSON.parse(readFileSync(path, 'utf8')).targetPlatform?.selected
  if (selected == null) return null
  const target = resolveSoc(typeof selected.soc === 'string' ? selected.soc : undefined)
  if (target === null || target.npuArch !== selected.npuArch) throw new Error('submission provenance contains an invalid target selection')
  return target
}

function withPaths(
  report: EvalReport,
  workspace: string,
  generationId: string | null,
  outbox: string,
  pendingStage: RunEvaluationValue['pendingStage'] = null,
  resultsPath: string | null = null,
  inbox?: string,
): RunEvaluationValue {
  return {
    ...report,
    workspace,
    packageDir: generationId === null ? null : join(workspace, 'packages', generationId),
    resultsPath,
    pendingStage,
    artifactsPersistent: ![outbox, inbox ?? outbox].some(path => /^\/(?:tmp|var\/tmp)(?:\/|$)/.test(path)),
    ...([outbox, inbox ?? outbox].some(path => /^\/(?:tmp|var\/tmp)(?:\/|$)/.test(path))
      ? { artifactWarning: 'Remote artifacts are in a temporary directory. Configure inbox/outbox under a persistent mount such as /mnt/workspace on CANNLab.' } : {}),
  }
}

const pendingEvaluations = new Map<string, Promise<RunEvaluationValue>>()

function serializeFormalEvaluations(
  configuredWorkspace: string | undefined,
  evaluate: (args: unknown, exec: ToolAgentContext | undefined, workspace: string) => Promise<RunEvaluationValue>,
) {
  return async (args: unknown, exec?: ToolAgentContext): Promise<RunEvaluationValue> => {
    const workspace = resolveWorkspace(configuredWorkspace, exec)
    if ((args as { compile_only?: boolean } | null)?.compile_only === true) {
      return evaluate(args, exec, workspace)
    }
    // Read and update the evaluation budget in order, even when a caller
    // submits two evaluations of the same workspace before either finishes.
    const key = statePath(workspace)
    const previous = pendingEvaluations.get(key)
    const result = Promise.resolve(previous).catch(() => undefined).then(() => evaluate(args, exec, workspace))
    pendingEvaluations.set(key, result)
    try {
      return await result
    } finally {
      if (pendingEvaluations.get(key) === result) pendingEvaluations.delete(key)
    }
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
  async function validateExportedSubmission(prepared: ReturnType<typeof prepareSubmission>, cfg: ReturnType<typeof snapshot>): Promise<JsonValue> {
    const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
    if ('summary' in connection) return {
      status: 'failed', correctness: 'unverified', stages: unverifiedSubmissionStages(), reason: connection.summary,
    }
    try {
      return await validateSubmission(connection.files, {
        ...prepared, remoteRoot: cfg.inbox, setEnv: cfg.setEnv, timeoutSec: cfg.timeoutSec,
        device: cfg.device, deviceLock: cfg.deviceLock || undefined,
      })
    } finally { await connection.files.close().catch(() => {}) }
  }

  ctx.tools.register(defineTool({
    name: 'run_evaluation',
    description: [
      'Upload the current test package and evaluate it on the remote NPU host.',
      'Call order is fixed: submit_spec -> write_operator -> build_test_package -> run_evaluation;',
      'run_evaluation requires the package that build_test_package wrote under packages/<generationId>.',
      'It uploads workspace/packages/<generationId> to a separate directory for each attempt over SSH exec (base64 tar, no SFTP),',
      'then on the remote host runs the package\'s build.sh, its run_once.sh, and the real msprof',
      '(CSV under mindstudio_profiler_output/), and returns the remote report path in resultsPath.',
      'Nothing is compiled locally: this Windows side has no CANN toolchain.',
      'A missing build.sh/run_once.sh is reported as compile_fail with "package does not implement build contract v1".',
      'A placeholder golden.h (write_package_file) returns accuracy_fail with "golden not implemented", never pass.',
      'An unchanged package reuses its previous measurement with duplicate:true; use force:true to remeasure.',
      'Optionally attach validation for an export of the same package after kernel correctness passes.',
      'The result always carries workspace, packageDir and resultsPath, plus status / compile.log /',
      'correctness.maxRelativeError / performance.kernelTimeUs / analysis / summary.',
      'Connection and transport failures leave pendingStage:run_evaluation. Restore the connection and retry the same package.',
    ].join(' '),
    parameters: {
      force: { type: 'boolean', description: 'Remeasure an unchanged package; recorded in runRecord.params.forced.' },
      compile_only: { type: 'boolean', description: 'Diagnostic build only. Does not run accuracy/msprof, consume evaluation budgets, or overwrite the last evaluation result.' },
      golden_fixtures: { type: 'string', description: 'Optional workspace-relative reference vector JSON. A failing local golden check prevents remote execution without spending budget.' },
      kernel_dtypes: { type: 'array', items: { type: 'string' }, description: 'Optional dtype variants for limited local host-stub kernel syntax lint before SSH. Does not validate target API support.' },
      submission: { type: 'object', additionalProperties: false, properties: submissionParameters },
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
                  kernelBudget: {
                    type: 'object', additionalProperties: false, properties: {
                      source: { type: 'string', const: 'correctness-stdout', required: true },
                      elementBasis: { type: 'string', required: true },
                      blocks: { type: 'array', required: true, items: {
                        type: 'object', additionalProperties: false, properties: {
                          blockIndex: { type: 'integer', required: true },
                          level2Calls: { type: 'integer', required: true },
                          elements: { type: 'integer', required: true },
                          callElements: { type: 'integer', required: true },
                        },
                      } },
                      level2Calls: { type: 'integer', required: true },
                      elements: { type: 'integer', required: true },
                      callElements: { type: 'integer', required: true },
                      perElementCalls: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                      averageElementsPerCall: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
                    },
                  },
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
          submission: { type: 'json' },
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
    execute: serializeFormalEvaluations(config.workspace, async (_args, exec, workspace) => {
      const force = (_args as { force?: boolean } | null)?.force === true
      const compileOnly = (_args as { compile_only?: boolean } | null)?.compile_only === true
      const submission = (_args as { submission?: SubmissionArgs } | null)?.submission
      if (compileOnly && submission) throw new Error('submission validation requires an accuracy evaluation')
      const cfg = snapshot(config)
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
      // compile_only is a diagnostic build: it writes no comparable evaluation
      // result, so a stale hash must not block it (CAN-104). The full gate still
      // applies to evaluations that consume budget.
      const currentHash = compileOnly ? packageHash(localPackageDir) : checkPackageHash(localPackageDir, state)
      const prepared = submission && prepareSubmission(workspace, submission)
      if (prepared) {
        const path = workspaceInput(workspace, join(prepared.sourceDir, 'provenance.json'), 'provenance.json')
        const provenance = JSON.parse(readFileSync(path, 'utf8'))
        if (provenance.generationId !== state.generationId || provenance.packageHash !== currentHash) {
          throw new Error('submission must contain an export of the same generation and package hash')
        }
      }
      const attachSubmission = async (report: RunEvaluationValue): Promise<RunEvaluationValue> => {
        if (!prepared) return report
        const validation = report.correctness.ok
          ? await validateExportedSubmission(prepared, cfg)
          : { status: 'not_run', reason: 'kernel correctness did not pass' }
        return { ...report, submission: validation }
      }
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
        return attachSubmission(withPaths(observed({
          ...state.lastReport,
          duplicate: true,
          summary: `duplicate package: same content as the last evaluation; previous result: ${state.lastReport.summary}`,
        }), workspace, state.generationId, cfg.outbox, null, state.lastResultsPath === undefined
          ? (state.lastReport.status === 'timeout' ? null : posix.join(cfg.outbox, state.generationId, 'results.json'))
          : state.lastResultsPath, cfg.inbox))
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
        device: cfg.device,
        deviceLock: cfg.deviceLock,
        state: { ...state, packageHash: currentHash },
        force,
        compileOnly,
        config: policyOf(config),
      }).catch(
        error => `remote evaluation interrupted: ${errorMessage(error)}. Check the remote host and rerun run_evaluation.`,
      ).finally(() => files.close().catch(() => {}))
      if (typeof outcome === 'string') return pending(outcome)
      const { report, state: next, resultWritten, resultsPath = null } = outcome
      if (report.status === 'error' && !resultWritten) return pending(report.summary)
      if (force && report.runRecord !== undefined) report.runRecord.params.forced = true
      if (compileOnly) return { ...withPaths(report, workspace, state.generationId, cfg.outbox, null, resultsPath, cfg.inbox),
        compileOnly: true }
      const latest = loadState(stateFile)
      if (latest.generationId === state.generationId && latest.packageHash === state.packageHash) {
        saveState(stateFile, {
          ...next,
          // This is a cache of the package just evaluated, not an authorization
          // source (CAN-104). Keep it aligned with what was measured.
          packageHash: currentHash,
          forcedRunsAfterStop: (state.forcedRunsAfterStop ?? 0) + (forcedAfterStop ? 1 : 0),
          pendingStage: null,
          lastEvaluatedHash: currentHash,
          lastResultsPath: resultsPath,
          ownerSessionId: owner ?? state.ownerSessionId ?? null,
          // One retry is owed for this report, and only for it.
          pendingSteer: !forcedAfterStop,
          steerCount: 0,
          lastSteerAt: 0,
        })
      }
      return attachSubmission(withPaths(observed(report), workspace, state.generationId, cfg.outbox, null, resultsPath, cfg.inbox))
    }),
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
      submission_source_dir: { type: 'string', description: 'Optional exported source directory. Read its selected target and compare with the remote architecture when requested.' },
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
      const selected = args.submission_source_dir ? readSubmissionTarget(workspace, args.submission_source_dir) : undefined
      let localChecks: JsonValue = args.golden_fixtures && packageDir
        ? { ...local, golden: await checkGolden(packageDir, localTargetFor(workspace, 'golden-fixtures.json', args.golden_fixtures)) }
        : local
      if (args.kernel_dtypes && packageDir) localChecks = { ...localChecks as Record<string, JsonValue>, kernel: await checkKernel(packageDir, args.kernel_dtypes) }
      if (localChecks !== null && typeof localChecks === 'object' && !Array.isArray(localChecks)) {
        if (selected !== undefined) localChecks.submissionTarget = selected ? { ...selected } : null
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
        const cann = await preflightToolchain(files, cfg.setEnv, cfg.device, cfg.deviceLock)
        const detectedSoc = cann && typeof cann === 'object' && !Array.isArray(cann) && typeof cann.detectedSoc === 'string'
          ? cann.detectedSoc : undefined
        const remote: Record<string, JsonValue> = { endpoint, ssh: 'connected', cann, quota }
        if (state.spec) remote.target = targetComparison(state.spec.target_platform, detectedSoc)
        if (selected) remote.submissionTarget = targetComparison({ chip: selected.soc }, detectedSoc)
        return { ...base, remote }
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
      'Use it to pull msprof CSVs or runner logs back after run_evaluation.',
      'To download the report, pass the returned resultsPath as remotePath.',
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
    name: 'probe_run',
    description: 'Build and check a temporary intrinsic probe from a kernel and an independent golden on the NPU. Uses the configured device and lock. Does not consume evaluation iterations or change the active generation. Supply a spec for different inputs or to work without an active generation.',
    parameters: {
      kernel: { type: 'string', required: true, description: 'Complete direct-launch kernel source.' },
      golden: { type: 'string', required: true, description: 'Complete independent golden.h reference.' },
      spec: { type: 'json', description: 'Optional probe spec. Defaults to the active spec. Performance target is ignored.' },
      record: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional workspace knowledge entry, recorded only after the probe passes.',
        properties: {
          title: { type: 'string', required: true },
          conclusion: { type: 'string', required: true },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec?: ToolAgentContext) {
      const workspace = resolveWorkspace(config.workspace, exec)
      const spec = args.spec ?? loadState(statePath(workspace)).spec
      if (spec == null) throw new Error('probe_run requires a spec or an active generation')
      const note = args.record && parseProbeConclusion(args.record)
      const cfg = snapshot(config)
      const connection = await openEvaluationRemote(ctx, connect, cfg, tunnel)
      if ('summary' in connection) return { report: unavailableReport(null, connection.summary), resultsPath: null } as unknown as JsonValue
      try {
        const probe = await runIntrinsicProbe({
          files: connection.files, inbox: cfg.inbox, outbox: cfg.outbox, setEnv: cfg.setEnv,
          device: cfg.device, deviceLock: cfg.deviceLock, timeoutMs: cfg.timeoutSec * 1000, intervalMs: cfg.pollIntervalMs,
        }, { kernel: args.kernel, golden: args.golden, spec })
        const knowledgePath = note && probe.report.status === 'pass' && probe.report.correctness.ok
          ? recordProbeConclusion(workspace, note, probe) : null
        return { ...probe, knowledgePath } as unknown as JsonValue
      } finally {
        await connection.files.close().catch(() => {})
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'validate_submission',
    description: 'Accept an exported submission independently of evaluation budgets. Reports wheel build, isolated install, invocation of the installed public callable, and comparison against a task-specific reference. With an official cases CSV it reports isolated per-case accuracy and coverage.',
    parameters: submissionParameters,
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec?: ToolAgentContext) {
      const workspace = resolveWorkspace(config.workspace, exec)
      return validateExportedSubmission(prepareSubmission(workspace, args), snapshot(config))
    },
  }))
}
