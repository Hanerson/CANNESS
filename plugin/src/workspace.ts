import { isAbsolute, join, resolve } from 'node:path'

export function resolveWorkspace(configured: string | undefined, context?: unknown): string {
  const cwd = (context as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)
    ?.agent?.session?.header?.cwd
  return resolve(typeof cwd === 'string' && isAbsolute(cwd) ? cwd : process.cwd(),
    configured || 'canness-workspace')
}

export function statePath(workspace: string): string {
  return join(workspace, '.canness', 'state.json')
}
