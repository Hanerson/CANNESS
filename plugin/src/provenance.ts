import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type SourceVerification = { status: 'verified' } | { status: 'unchecked'; reason: string }

export type Origin = {
  kind: 'generated' | 'adapted_from' | 'copied_from'
  source?: string
  sourceFile?: string
  sha256?: string
  verification?: SourceVerification
}

type Layer = 'kernel' | 'host' | 'api' | 'plugin'
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024
const NO_SOURCE_FILE = 'no workspace-relative sourceFile was provided'

function unchecked(reason: string): SourceVerification {
  return { status: 'unchecked', reason }
}

function recordedVerification(origin: Origin, value: unknown): SourceVerification | undefined {
  if (origin.source === undefined && origin.sourceFile === undefined && origin.sha256 === undefined) return
  if (value !== null && typeof value === 'object') {
    const { status, reason } = value as Record<string, unknown>
    if (status === 'verified' && origin.sourceFile && origin.sha256) return { status }
    if (status === 'unchecked' && typeof reason === 'string' && reason.trim()) return unchecked(reason)
  }
  return unchecked(origin.sourceFile ? 'the source digest has not been checked' : NO_SOURCE_FILE)
}

export function parseProvenance(value: unknown): Partial<Record<Layer, Origin>> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('provenance must be an object keyed by operator layer')
  }
  const origins: Partial<Record<Layer, Origin>> = {}
  for (const [layer, entry] of Object.entries(value)) {
    if (layer !== 'kernel' && layer !== 'host' && layer !== 'api' && layer !== 'plugin') {
      throw new Error(`unknown provenance layer: ${layer}`)
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`provenance.${layer} must be an object`)
    }
    const { kind, source, sourceFile, sha256, verification } = entry as Record<string, unknown>
    if (kind !== 'generated' && kind !== 'adapted_from' && kind !== 'copied_from') {
      throw new Error(`invalid provenance kind for ${layer}`)
    }
    if ((kind !== 'generated' || source !== undefined) && (typeof source !== 'string' || source.trim() === '')) {
      throw new Error(`provenance.${layer}.source must name the reference`)
    }
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) {
      throw new Error(`provenance.${layer}.sha256 must be a SHA-256 digest in hex`)
    }
    const filename = typeof sourceFile === 'string' ? sourceFile.trim().replace(/\\/g, '/') : ''
    if (sourceFile !== undefined && (!filename || filename.startsWith('/') || filename.includes(':') ||
        filename.includes('\0') || filename.split('/').includes('..'))) {
      throw new Error(`provenance.${layer}.sourceFile must be a workspace-relative file path`)
    }
    const origin: Origin = {
      kind,
      ...(typeof source === 'string' ? { source } : {}),
      ...(filename ? { sourceFile: filename } : {}),
      ...(typeof sha256 === 'string' ? { sha256: sha256.toLowerCase() } : {}),
    }
    const recorded = recordedVerification(origin, verification)
    if (recorded !== undefined) origin.verification = recorded
    origins[layer] = origin
  }
  return origins
}

function readSourceDigest(path: string): { digest: string } | { reason: string } {
  try {
    const resolved = statSync(path)
    if (!resolved.isFile()) return { reason: 'sourceFile must identify a regular file' }
    if (resolved.size > MAX_REFERENCE_BYTES) return { reason: 'sourceFile exceeds the 8 MiB verification limit' }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const opened = fstatSync(fd)
      const changed = 'sourceFile changed during verification'
      if (!opened.isFile() || opened.size !== resolved.size || opened.dev !== resolved.dev || opened.ino !== resolved.ino ||
          realpathSync(path) !== path) return { reason: changed }
      // Bound the read even if another process appends to the file.
      const bytes = Buffer.allocUnsafe(opened.size + 1)
      let used = 0
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, null)
        if (count === 0) break
        used += count
      }
      if (used !== opened.size || fstatSync(fd).mtimeMs !== opened.mtimeMs) return { reason: changed }
      return { digest: sha256(bytes.subarray(0, used)) }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { reason: 'sourceFile could not be read' }
  }
}

function outsideWorkspace(root: string, path: string): boolean {
  const within = relative(root, path)
  return within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)
}

/** Verify only the explicit file reference on a newly written provenance claim. */
export function verifyOrigin(workspace: string, layer: Layer, origin: Origin): Origin {
  if (!origin.sourceFile) {
    return origin.verification ? { ...origin, verification: unchecked(NO_SOURCE_FILE) } : origin
  }
  if (!origin.sha256) return { ...origin, verification: unchecked('no source SHA-256 was declared') }
  const root = realpathSync(workspace)
  const candidate = resolve(root, origin.sourceFile)
  const escapeError = `provenance.${layer}.sourceFile resolves outside the workspace`
  if (outsideWorkspace(root, candidate)) throw new Error(escapeError)
  let path: string
  try {
    path = realpathSync(candidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'sourceFile was not found' : 'sourceFile could not be resolved'
    return { ...origin, verification: unchecked(reason) }
  }
  if (outsideWorkspace(root, path)) throw new Error(escapeError)
  const result = readSourceDigest(path)
  if ('reason' in result) return { ...origin, verification: unchecked(result.reason) }
  if (result.digest !== origin.sha256) {
    throw new Error(`provenance.${layer} source SHA-256 does not match ${JSON.stringify(origin.sourceFile)}`)
  }
  return { ...origin, verification: { status: 'verified' } }
}

export function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex')
}

function nonemptyLines(source: string): string[] {
  return source.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

/** Sørensen–Dice similarity over the multiset of trimmed nonempty lines. */
export function lineOverlap(left: string, right: string): number {
  const first = nonemptyLines(left)
  const second = nonemptyLines(right)
  if (first.length + second.length === 0) return 0
  const count = new Map<string, number>()
  for (const line of first) count.set(line, (count.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of second) {
    const remaining = count.get(line) ?? 0
    if (remaining > 0) {
      shared += 1
      count.set(line, remaining - 1)
    }
  }
  return 2 * shared / (first.length + second.length)
}
