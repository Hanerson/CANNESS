import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { entryKinds, evidenceTypes } from './knowledge-entry.js'
import { queryKnowledge } from './knowledge-search.js'

export const name = 'canness-knowledge'
export const inject = ['tools']

export interface Config { kbRoot: string }

export const Config: z<Config> = z.object({
  kbRoot: z.string().required(),
})

const stringList = { type: 'array', items: { type: 'string' } } as const
const parameters = {
  operator_name: { type: 'string', description: 'Canonical operator name or alias, e.g. ArgMax.' },
  query: { type: 'string', description: 'Terms, code symbols, error text, or a diagnostic question. Max 500 characters.' },
  hardware: { type: 'string', description: 'Hardware target, e.g. 950pr or 910b.' },
  dtype: { type: 'string', description: 'Relevant input dtype, e.g. bf16.' },
  layout: { type: 'string', description: 'Relevant layout, e.g. contiguous or strided.' },
  cann_version: { type: 'string', description: 'Exact CANN version when known.' },
  kind: { type: 'string', enum: entryKinds, description: 'Restrict to one knowledge entry kind.' },
  limit: { type: 'integer', description: 'Maximum hits, from 1 to 8. Default: 4.' },
} as const

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: [
      'Search CANNESS knowledge for operator contracts, implementation, troubleshooting or benchmarks.',
      'Supply operator_name or query. Use query for API names, error signatures, or symptoms.',
      'Pass hardware, dtype, layout, CANN version and kind when known.',
      'An operator_name-only call returns compatibility text. Other calls return structured hits with source references.',
    ].join(' '),
    parameters,
    output: {
      schema: { oneOf: [
        { type: 'string' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            schema_version: { type: 'integer', const: 1, required: true },
            has_more: { type: 'boolean', required: true },
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  schema_version: { type: 'integer', const: 1, required: true },
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  kind: { type: 'string', required: true, enum: entryKinds },
                  operator: { type: 'string' },
                  aliases: stringList,
                  hardware: stringList,
                  dtypes: stringList,
                  layouts: stringList,
                  cann_versions: stringList,
                  keywords: stringList,
                  evidence: { type: 'string', required: true, enum: evidenceTypes },
                  sources: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        ref: { type: 'string', required: true },
                        sha256: { type: 'string' },
                      },
                    },
                  },
                  body: { type: 'string', required: true },
                },
              },
            },
          },
        },
      ] },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    },
    async execute(args) {
      for (const [key, value] of Object.entries(args)) {
        if (!Object.hasOwn(parameters, key)) throw new Error(`unknown parameter ${key}`)
        if (typeof value !== 'string') continue
        const max = key === 'query' ? 500 : 120
        if (!value.trim() || value.length > max) throw new Error(`${key} must have 1–${max} characters and not be blank`)
      }
      if (args.limit !== undefined && (args.limit < 1 || args.limit > 8)) throw new Error('limit must be from 1 to 8')
      return queryKnowledge(config.kbRoot, args)
    },
  }))
}
