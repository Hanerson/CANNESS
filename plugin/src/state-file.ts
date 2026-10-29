import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyState, type TaskState } from './policy.ts'

export function loadState(path: string): TaskState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

export function saveState(path: string, state: TaskState): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2))
}
