import type { TaskState } from './policy.js'
import { loadState, saveState } from './state-file.js'

export function taskSessionId(context: unknown): string | null {
  const id = (context as { agent?: { session?: { id?: unknown } } } | undefined)?.agent?.session?.id
  return typeof id === 'string' && id.trim() !== '' ? id : null
}
export class OwnershipError extends Error {
  readonly blockedBy = 'ownership'
  constructor(readonly ownerSession: string, readonly session: string | null, readonly tool: string) {
    super(`${tool}: ownership conflict: workspace belongs to session ${ownerSession}; caller ${session ?? '(unknown session)'} cannot modify this task. Use a separate workspace for another active task.`)
    this.name = 'OwnershipError'
  }
}
/** Synchronous guard: no artifact, budget or owner changes precede this check. */
export function assertTaskOwnership(stateFile: string, tool: string, context: unknown): TaskState {
  const state = loadState(stateFile)
  const session = taskSessionId(context)
  if (state.ownerSessionId && state.ownerSessionId !== session) {
    const error = new OwnershipError(state.ownerSessionId, session, tool)
    saveState(stateFile, { ...state, lastBlocked: { reason: error.message, at: new Date().toISOString(), session, blockedBy: 'ownership' } })
    throw error
  }
  return state
}
/** Claim only an unowned task; never transfer an existing owner, including on reset. */
export function claimTaskOwnership(stateFile: string, tool: string, context: unknown): TaskState {
  const state = assertTaskOwnership(stateFile, tool, context)
  const session = taskSessionId(context)
  if (state.generationId == null) return state
  if ((!state.ownerSessionId && session) || !state.budgetWindowStartedAt) {
    const next = { ...state, ownerSessionId: state.ownerSessionId ?? session, budgetWindowStartedAt: state.budgetWindowStartedAt ?? new Date().toISOString() }
    saveState(stateFile, next)
    return next
  }
  return state
}
