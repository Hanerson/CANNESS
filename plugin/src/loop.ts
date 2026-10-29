import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { enhancementBlock, shouldSteer, type PolicyConfig } from './policy.js'
import { loadState } from './state-file.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'canness-loop': { kind: 'canness-loop'; form: 'notice'; summary: string }
  }
}

export const name = 'canness-loop'
export const inject = [] as const

export interface Config extends PolicyConfig { workspace: string }

export const Config: z<Config> = z.object({
  workspace: z.string().required(),
  maxIterations: z.number().required(),
  maxCompileRetries: z.number().required(),
  negativeStreakLimit: z.number().required(),
  convergenceThreshold: z.number().required(),
})

function notice(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'canness-loop' as const, form: 'notice' as const, summary: 'retry operator' },
  })
}

export function apply(ctx: Context, config: Config): void {
  const path = join(config.workspace, '.canness', 'state.json')
  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = loadState(path)
    const text = enhancementBlock(state)
    if (!text || state.lastReport == null || state.lastReport.status === 'pass') return decision
    const already = decision.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text === text),
    )
    if (already) return decision
    return {
      kind: 'enter',
      ...(decision.startsRequestSeries ? { startsRequestSeries: true as const } : {}),
      messages: [...decision.messages, notice(text)],
    }
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const state = loadState(path)
    if (!shouldSteer(state, config)) return
    agent.steer(notice(enhancementBlock(state)))
  })
}
