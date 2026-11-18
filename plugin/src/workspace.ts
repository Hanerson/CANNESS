import { isAbsolute, join, resolve } from 'node:path'

/**
 * Resolve the CANNESS artifact workspace: the session working directory itself.
 *
 * Artifacts (`operators/`, `packages/`, `submissions/`, `.canness/`) live directly
 * in the session cwd, never in a nested `canness-workspace/` directory. The nested
 * layout used to sit below the sandbox's writable root without carrying its
 * capability-SID grant, so shell-driven steps (build, copy, package) were denied
 * inside the artifact tree while the plugin's own file writes succeeded.
 *
 * An explicit `workspace` config resolves against the session cwd and replaces it.
 *
 * @param configured - the `workspace` config value, when set.
 * @param context - tool context carrying the session cwd.
 * @returns the absolute workspace directory.
 */
export function resolveWorkspace(configured: string | undefined, context?: unknown): string {
  const session = (context as { agent?: { session?: { cwd?: unknown; header?: { cwd?: unknown } } } } | undefined)?.agent?.session
  const cwd = [session?.cwd, session?.header?.cwd].find(value => typeof value === 'string' && isAbsolute(value))
  const base = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : process.cwd()
  return configured ? resolve(base, configured) : base
}

export function statePath(workspace: string): string {
  return join(workspace, '.canness', 'state.json')
}
