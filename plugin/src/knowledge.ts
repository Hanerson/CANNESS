import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { searchKnowledge } from './knowledge-search.js'

export const name = 'canness-knowledge'
export const inject = ['tools']

export interface Config { kbRoot: string }

export const Config: z<Config> = z.object({
  kbRoot: z.string().required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: 'Search CANNESS knowledge notes by operator name.',
    parameters: {
      operator_name: { type: 'string', required: true, description: 'Operator name, for example Add' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      return searchKnowledge(config.kbRoot, args.operator_name)
    },
  }))
}
