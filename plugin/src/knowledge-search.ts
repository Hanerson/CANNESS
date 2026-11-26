import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { entryKinds, knowledgeRootPath, loadKnowledgeEntries, outputBudget, type KnowledgeEntry } from './knowledge-entry.js'

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function normalizeDtype(value: string): string {
  const dtype = normalize(value)
  const aliases: Record<string, string> = {
    fp16: 'float16', half: 'float16', fp32: 'float32', bf16: 'bfloat16',
  }
  return Object.hasOwn(aliases, dtype) ? aliases[dtype] : dtype
}

export interface KnowledgeQuery {
  operator_name?: string
  query?: string
  hardware?: string
  dtype?: string
  layout?: string
  cann_version?: string
  kind?: typeof entryKinds[number]
  limit?: number
}

export interface KnowledgeResults {
  schema_version: 1
  hits: KnowledgeEntry[]
  has_more: boolean
}

function terms(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.normalize('NFKC')
  const words = normalized.match(/\p{Script=Han}+|[a-z\d]+(?:[_-][a-z\d]+)*/giu) ?? []
  for (const word of words) {
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = [...word]
      if (chars.length === 1) tokens.add(word)
      for (let i = 1; i < chars.length; i++) tokens.add(chars[i - 1] + chars[i])
    } else {
      tokens.add(normalize(word))
      const parts = word.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(/[ _-]+/)
      for (const part of parts) tokens.add(part.toLowerCase())
    }
  }
  return tokens
}

function matchCount(query: Set<string>, text: string): number {
  const candidate = terms(text)
  let count = 0
  for (const token of query) if (candidate.has(token)) count++
  return count
}

function scopes(entry: KnowledgeEntry, args: KnowledgeQuery): number {
  const filters = [
    [args.hardware, entry.hardware, normalize],
    [args.dtype, entry.dtypes, normalizeDtype],
    [args.layout, entry.layouts, normalize],
    [args.cann_version, entry.cann_versions, value => value.trim().normalize('NFKC').toLowerCase()],
  ] as const satisfies ReadonlyArray<readonly [string | undefined, string[] | undefined, (value: string) => string]>
  let specific = 0
  for (const [wanted, known, canonical] of filters) {
    if (wanted === undefined || known === undefined) continue
    if (!known.some(value => canonical(value) === canonical(wanted))) return -1
    specific++
  }
  return specific
}

function searchStructured(root: URL | string, args: KnowledgeQuery, additional: readonly KnowledgeEntry[] = []): KnowledgeResults {
  const query = terms(args.query ?? '')
  if (args.query !== undefined && !query.size) throw new Error('query must contain a searchable term')
  const operator = args.operator_name === undefined ? undefined : normalize(args.operator_name)
  if (operator === '') throw new Error('operator_name must contain a letter or number')

  const ranked: { entry: KnowledgeEntry; specificity: number; score: number; operatorMatch: boolean }[] = []
  for (const entry of [...loadKnowledgeEntries(root), ...additional]) {
    if (args.kind && entry.kind !== args.kind) continue
    const names = entry.operator === undefined ? [] : [entry.operator, ...(entry.aliases ?? [])]
    const operatorMatch = operator !== undefined && names.some(name => normalize(name) === operator)
    if (operator !== undefined && !operatorMatch && (entry.operator !== undefined || !query.size)) continue
    const specificity = scopes(entry, args)
    if (specificity < 0) continue

    const score = query.size
      ? 3 * matchCount(query, [entry.title, ...names, ...(entry.keywords ?? [])].join(' ')) + matchCount(query, entry.body)
      : 0
    if (query.size && score === 0) continue
    ranked.push({ entry, specificity, score, operatorMatch })
  }
  ranked.sort((a, b) => b.score - a.score || Number(b.operatorMatch) - Number(a.operatorMatch)
    || b.specificity - a.specificity)

  const result: KnowledgeResults = { schema_version: 1, hits: [], has_more: false }
  for (const { entry } of ranked.slice(0, args.limit ?? 4)) {
    result.hits.push(entry)
    if (JSON.stringify(result).length > outputBudget) {
      result.hits.pop()
      break
    }
  }
  // The serialized spelling of false is one character longer than true.
  result.has_more = result.hits.length < ranked.length
  return result
}

export function searchKnowledge(root: URL | string, operatorName: string): string {
  const structured = searchStructured(root, { operator_name: operatorName })
  if (structured.hits.length) {
    const snippets = structured.hits.map(entry => [
      `## ${entry.title}`,
      JSON.stringify({ ...entry, title: undefined, body: undefined }),
      entry.body,
    ].join('\n'))
    return snippets.join('\n\n')
  }

  const dir = knowledgeRootPath(root)
  const needle = operatorName.toLowerCase()
  const hits: string[] = []
  for (const file of readdirSync(dir).sort()) {
    const full = join(dir, file)
    if (statSync(full).isFile() && file.toLowerCase().includes(needle)) hits.push(readFileSync(full, 'utf8'))
  }
  if (hits.length === 0) return `no knowledge entry for ${operatorName}`
  return hits.join('\n').slice(0, outputBudget)
}

export function queryKnowledge(root: URL | string, args: KnowledgeQuery, additional?: readonly KnowledgeEntry[]): string | KnowledgeResults {
  if (!args.operator_name && !args.query) throw new Error('Specify operator_name or query')
  if (additional === undefined && args.operator_name !== undefined && Object.keys(args).every(key => key === 'operator_name')) {
    return searchKnowledge(root, args.operator_name)
  }
  return searchStructured(root, args, additional)
}
