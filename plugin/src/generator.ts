import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { newGenerationId } from './ids.js'
import { buildTestPackage, checkKernelEntry, KERNEL_ENTRY, writeOperator } from './package-files.js'
import { emptyState } from './policy.js'
import { parseSpec } from './spec.js'
import { loadState, saveState } from './state-file.js'

export const name = 'canness-generator'
export const inject = ['tools']

export interface Config { workspace: string }

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
})

function statePath(workspace: string): string {
  return join(workspace, '.canness', 'state.json')
}

function render(value: unknown): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export function apply(ctx: Context, config: Config): void {
  const path = statePath(config.workspace)
  ctx.tools.register(defineTool({
    name: 'submit_spec',
    description: [
      'Validate an operator spec and start a new generation.',
      'Resubmitting for the same operator keeps the iteration budget: counters, the best time, and the',
      'stall window carry over, so a new generation is a new artifact rather than a fresh allowance.',
      'Pass reset: true to start the budget over deliberately.',
      'A target_us larger than the previous spec\'s is recorded and reported as a relaxed target.',
    ].join(' '),
    parameters: {
      spec: { type: 'json', required: true, description: 'Operator spec JSON from design doc 02 section 3.1' },
      reset: { type: 'boolean', description: 'Restart the iteration budget instead of carrying it over.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { type: 'string', required: true },
          operator_name: { type: 'string', required: true },
          carriedOver: { type: 'boolean', required: true },
          relaxedTargetFromUs: { required: true, oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const spec = parseSpec(args.spec)
      const generationId = newGenerationId(randomUUID())
      const prior = loadState(path)
      // The budget is per operator, not per generation id: resubmitting the same
      // operator must not hand the loop a fresh allowance, or the stop
      // conditions can never be reached (see issue 016).
      const carriedOver = args.reset !== true
        && prior.generationId !== null
        && prior.spec !== null
        && prior.spec.operator_name === spec.operator_name
      const priorTarget = prior.spec?.performance_target.target_us
      const relaxedTargetFromUs = carriedOver && priorTarget !== undefined
        && spec.performance_target.target_us > priorTarget
        ? priorTarget
        : null
      saveState(path, {
        ...emptyState(),
        ...carriedOver
          ? {
              validIterations: prior.validIterations,
              compileRetries: prior.compileRetries,
              timeouts: prior.timeouts,
              negativeStreak: prior.negativeStreak,
              bestKernelTimeUs: prior.bestKernelTimeUs,
              previousPassKernelTimeUs: prior.previousPassKernelTimeUs,
              lastPassKernelTimeUs: prior.lastPassKernelTimeUs,
              recentKernelTimeUs: prior.recentKernelTimeUs ?? [],
              // A new generation stays owned by the session that started the
              // task; nothing is owed until it is evaluated.
              ownerSessionId: prior.ownerSessionId ?? null,
            }
          : {},
        generationId,
        spec,
        targetRelaxedUs: relaxedTargetFromUs,
        // A fresh generation owes nothing until it has been evaluated, and it
        // keeps the owner recorded above so the loop still knows whose task it
        // is — otherwise a resubmission would silently orphan the task and the
        // loop would fall silent for the session that owns it.
        pendingSteer: false,
      })
      return {
        generationId,
        operator_name: spec.operator_name,
        carriedOver,
        relaxedTargetFromUs,
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write_operator',
    description: [
      'Write the four operator layer files for the current generation.',
      `The kernel entry point is fixed: op_kernel/kernel.cpp must define "extern \"C\" __global__ __aicore__ void ${KERNEL_ENTRY}(<inputs>, <outputs>, GM_ADDR tiling)" —`,
      'inputs first, then outputs, then the tiling pointer, and no workspace argument.',
      'The package\'s main.cpp calls that exact symbol, so any other name or parameter order fails to link.',
    ].join(' '),
    parameters: {
      kernel: { type: 'string', required: true, description: `op_kernel/kernel.cpp body; must define void ${KERNEL_ENTRY}(<inputs>, <outputs>, GM_ADDR tiling)` },
      host: { type: 'string', required: true, description: 'op_host/host.cpp body' },
      api: { type: 'string', required: true, description: 'op_api/api.cpp body' },
      plugin: { type: 'string', required: true, description: 'op_plugin/plugin.py body' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { operatorDir: { type: 'string', required: true } },
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const state = loadState(path)
      if (state.generationId == null || state.spec == null) throw new Error('submit_spec first')
      const entry = checkKernelEntry(args.kernel)
      if (!entry.ok) throw new Error(entry.reason)
      const operatorDir = writeOperator(config.workspace, state.generationId, {
        kernel: args.kernel, host: args.host, api: args.api, plugin: args.plugin,
      })
      return { operatorDir }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'build_test_package',
    description: [
      'Assemble the current generation into a build-contract-v1 package: the four operator layers plus',
      'build.sh, run_once.sh, main.cpp, golden.h, canness_tiling.h, config.json and manifest.json.',
      'main.cpp/build.sh/run_once.sh/canness_tiling.h are rendered by the plugin and are operator-independent;',
      'the accuracy reference comes from golden.h (the model-owned extension point).',
      `The kernel entry must be void ${KERNEL_ENTRY}(<inputs>, <outputs>, GM_ADDR tiling); this tool refuses to`,
      'package a kernel that does not define it.',
      'manifest.json.files lists what actually landed on disk; manifest.json.layers lists the four layers.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { packageDir: { type: 'string', required: true } },
      },
      render: (_args, value) => render(value),
    },
    async execute() {
      const state = loadState(path)
      if (state.generationId == null || state.spec == null) throw new Error('submit_spec first')
      return { packageDir: buildTestPackage(config.workspace, state.generationId, state.spec) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write_package_file',
    description: [
      'Write golden.h for the current generation — the only package file the model may own.',
      'Replace the whole file with the operator\'s accuracy formula and remove the',
      'CANNESS_GOLDEN_PLACEHOLDER define; until then evaluation reports accuracy_fail with',
      '"golden not implemented". The write goes to operators/<generationId>/golden.h (and to the',
      'existing package copy), so run build_test_package again to refresh the uploaded package.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Only "golden.h" is accepted.' },
      content: { type: 'string', required: true, description: 'Complete golden.h body.' },
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
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const state = loadState(path)
      if (state.generationId == null || state.spec == null) throw new Error('submit_spec first')
      const normalized = args.path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      if (normalized !== 'golden.h') {
        throw new Error('write_package_file only accepts golden.h')
      }
      const body = args.content
      const destinations = [join(config.workspace, 'operators', state.generationId, 'golden.h')]
      const packageCopy = join(config.workspace, 'packages', state.generationId, 'golden.h')
      if (existsSync(dirname(packageCopy))) destinations.push(packageCopy)
      for (const destination of destinations) {
        mkdirSync(dirname(destination), { recursive: true })
        writeFileSync(destination, body)
      }
      return { path: destinations[0]!, bytes: Buffer.byteLength(body) }
    },
  }))
}
