import { createHash } from 'node:crypto'

export type Origin = {
  kind: 'generated' | 'adapted_from' | 'copied_from'
  source?: string
  sha256?: string
}

type Layer = 'kernel' | 'host' | 'api' | 'plugin'

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
    const { kind, source, sha256 } = entry as Record<string, unknown>
    if (kind !== 'generated' && kind !== 'adapted_from' && kind !== 'copied_from') {
      throw new Error(`invalid provenance kind for ${layer}`)
    }
    if ((kind !== 'generated' || source !== undefined) && (typeof source !== 'string' || source.trim() === '')) {
      throw new Error(`provenance.${layer}.source must name the reference`)
    }
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) {
      throw new Error(`provenance.${layer}.sha256 must be a SHA-256 digest in hex`)
    }
    origins[layer] = {
      kind,
      ...(typeof source === 'string' ? { source } : {}),
      ...(typeof sha256 === 'string' ? { sha256: sha256.toLowerCase() } : {}),
    }
  }
  return origins
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
