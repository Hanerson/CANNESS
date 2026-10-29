import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CAP = 8000

export function searchKnowledge(root: URL | string, operatorName: string): string {
  const dir = root instanceof URL ? fileURLToPath(root) : root
  const needle = operatorName.toLowerCase()
  const hits: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (!statSync(full).isFile()) continue
    if (!name.toLowerCase().includes(needle)) continue
    hits.push(readFileSync(full, 'utf8'))
  }
  if (hits.length === 0) return `no knowledge entry for ${operatorName}`
  return hits.join('\n').slice(0, CAP)
}
