import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { enhancementBlock, ownsSession, shouldSteer, type PolicyConfig } from './policy.js'
import { loadState, saveState } from './state-file.js'

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
  // Defaults keep the round working without the three newer policy keys.
  stallRounds: z.number().default(2),
  stallGain: z.number().default(0.03),
  stallGap: z.number().default(1.5),
})

function notice(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'canness-loop' as const, form: 'notice' as const, summary: 'retry operator' },
  })
}

/** The session identity this event carries, if the caller supplied one. */
function sessionOf(payload: unknown): string | undefined {
  const agent = (payload as { agent?: { session?: { id?: unknown } } } | undefined)?.agent
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

export function apply(ctx: Context, config: Config): void {
  const path = join(config.workspace, '.canness', 'state.json')

  /**
   * Both listeners share this guard. Driving a session requires three things at
   * once: this session owns the task, an evaluation wrote a report that still
   * owes a retry, and the policy has not stopped the loop. Any one of them
   * missing leaves the turn alone — the previous version checked only the last
   * condition and so drove every session on every turn.
   * @param payload - the event payload, which carries the agent.
   * @returns the state to steer with, or undefined to stay quiet.
   */
  const steerable = (payload: unknown): ReturnType<typeof loadState> | undefined => {
    const state = loadState(path)
    if (!ownsSession(state, sessionOf(payload))) return undefined
    if (state.pendingSteer !== true) return undefined
    if (!shouldSteer(state, config)) return undefined
    return state
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = steerable(payload)
    if (state === undefined) return decision
    const text = enhancementBlock(state, config)
    const already = decision.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text === text),
    )
    if (already) return decision
    // The retry is owed once. Consuming it here keeps the next turn from
    // receiving the same sentence again; the turn-stopping steer below only
    // fires when this path did not.
    saveState(path, { ...state, pendingSteer: false })
    return {
      kind: 'enter',
      ...(decision.startsRequestSeries ? { startsRequestSeries: true as const } : {}),
      messages: [...decision.messages, notice(text)],
    }
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const state = steerable(payload)
    if (state === undefined) return
    const agent = (payload as { agent?: { steer(message: unknown): void } }).agent
    if (agent === undefined || typeof agent.steer !== 'function') return
    // Consume before steering: a steer starts a turn, and that turn must not
    // find the same pending retry waiting for it.
    saveState(path, { ...state, pendingSteer: false })
    agent.steer(notice(enhancementBlock(state, config)))
  })
}
