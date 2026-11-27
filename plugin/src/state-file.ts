import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptyState, type TaskState } from './policy.js'

export function loadState(path: string): TaskState {
  try {
    return { ...emptyState(), ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
}

export function saveState(path: string, state: TaskState): void {
  writeStateJson(path, state)
}

export function writeStateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function saveGenerationState(path: string, state: TaskState): void {
  if (state.generationId === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(state.generationId)) {
    throw new Error('cannot archive an invalid generation ID')
  }
  saveState(join(dirname(path), 'generations', state.generationId, 'state.json'), state)
}
