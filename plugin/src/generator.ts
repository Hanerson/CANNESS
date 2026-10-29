import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { newGenerationId } from './ids.js'
import { buildTestPackage, writeOperator } from './package-files.js'
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
    description: 'Validate an operator spec and start a new generation.',
    parameters: {
      spec: { type: 'json', required: true, description: 'Operator spec JSON from design doc 02 section 3.1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          generationId: { type: 'string', required: true },
          operator_name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => render(value),
    },
    async execute(args) {
      const spec = parseSpec(args.spec)
      const generationId = newGenerationId(randomUUID())
      saveState(path, { ...emptyState(), generationId, spec })
      return { generationId, operator_name: spec.operator_name }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'write_operator',
    description: 'Write the four operator layer files for the current generation.',
    parameters: {
      kernel: { type: 'string', required: true, description: 'op_kernel/kernel.cpp body' },
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
      const operatorDir = writeOperator(config.workspace, state.generationId, {
        kernel: args.kernel, host: args.host, api: args.api, plugin: args.plugin,
      })
      return { operatorDir }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'build_test_package',
    description: 'Copy the current operator layers into a package directory and write manifest.json.',
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
}
