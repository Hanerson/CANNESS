import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const entryKinds = ['contract', 'implementation', 'troubleshooting', 'benchmark'] as const
export const evidenceTypes = ['specification', 'source_inspection', 'reported', 'reproduced'] as const

export interface KnowledgeSource {
  ref: string
  sha256?: string
}

export interface KnowledgeEntry {
  schema_version: 1
  id: string
  title: string
  kind: typeof entryKinds[number]
  operator?: string
  aliases?: string[]
  hardware?: string[]
  dtypes?: string[]
  layouts?: string[]
  cann_versions?: string[]
  keywords?: string[]
  evidence: typeof evidenceTypes[number]
  sources: KnowledgeSource[]
  body: string
}

export const outputBudget = 8000
const headerFields = new Set([
  'schema_version', 'id', 'title', 'kind', 'operator', 'aliases', 'hardware', 'dtypes',
  'layouts', 'cann_versions', 'keywords', 'evidence', 'sources',
])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEntry(file: string): KnowledgeEntry {
  const markdown = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(markdown)
  const invalid = (message: string): never => { throw new Error(`Invalid knowledge entry ${basename(file)}: ${message}`) }
  if (!match) return invalid('expected a JSON header between --- lines and a Markdown body')

  let header: unknown
  try { header = JSON.parse(match[1]) }
  catch { return invalid('header must be valid JSON') }
  if (!isObject(header)) return invalid('header must be an object')
  for (const key of Object.keys(header)) {
    if (!headerFields.has(key)) return invalid(`unknown field ${key}`)
  }

  function string(value: unknown, field: string, max = 120): string {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
      return invalid(`${field} must be a trimmed nonempty string of at most ${max} characters`)
    }
    return value
  }

  function list(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || !value.length || value.length > 16) {
      return invalid(`${field} must contain 1–16 strings`)
    }
    return value.map(item => string(item, field))
  }

  const id = string(header.id, 'id', 80)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || basename(file) !== `${id}.md`) {
    return invalid('id must use lowercase kebab-case and match the filename')
  }
  if (header.schema_version !== 1) return invalid('schema_version must be 1')
  const kind = entryKinds.find(value => value === header.kind)
  if (!kind) return invalid(`kind must be one of ${entryKinds.join(', ')}`)
  const evidence = evidenceTypes.find(value => value === header.evidence)
  if (!evidence) return invalid(`evidence must be one of ${evidenceTypes.join(', ')}`)
  if (!Array.isArray(header.sources) || !header.sources.length || header.sources.length > 8) {
    return invalid('sources must contain 1–8 source objects')
  }
  const sources = header.sources.map((source: unknown) => {
    if (!isObject(source) || Object.keys(source).some(key => key !== 'ref' && key !== 'sha256')) {
      return invalid('each source must have ref and may have sha256')
    }
    const ref = string(source.ref, 'sources.ref', 500)
    if (source.sha256 === undefined) return { ref }
    const sha256 = string(source.sha256, 'sources.sha256', 64)
    if (!/^[a-f\d]{64}$/i.test(sha256)) return invalid('sources.sha256 must be a 64-digit hex digest')
    return { ref, sha256 }
  })

  const operator = header.operator === undefined ? undefined : string(header.operator, 'operator')
  const aliases = list(header.aliases, 'aliases')
  if (!operator && aliases) return invalid('aliases requires operator')
  const body = string(match[2].trim(), 'body', 1800)
  const entry: KnowledgeEntry = { schema_version: 1, id, title: string(header.title, 'title'), kind, evidence, sources, body }
  if (operator) entry.operator = operator
  if (aliases) entry.aliases = aliases
  for (const field of ['hardware', 'dtypes', 'layouts', 'cann_versions', 'keywords'] as const) {
    const values = list(header[field], field)
    if (values) entry[field] = values
  }
  if (JSON.stringify(entry).length > outputBudget - 100) return invalid('entry exceeds the serialized output budget')
  return entry
}

export function knowledgeRootPath(root: URL | string): string {
  return resolve(root instanceof URL ? fileURLToPath(root) : root)
}

export function loadKnowledgeEntries(root: URL | string): KnowledgeEntry[] {
  const rootPath = knowledgeRootPath(root)
  const dir = join(rootPath, 'entries')
  let files: Dirent[]
  try { files = readdirSync(dir, { withFileTypes: true }) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!statSync(rootPath, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`Knowledge base root is missing or is not a directory: ${rootPath}`, { cause: error })
      }
      if (code === 'ENOENT') return []
    }
    throw error
  }
  return files
    .filter(file => file.isFile() && file.name.endsWith('.md'))
    .map(file => file.name)
    .sort()
    .map(filename => readEntry(join(dir, filename)))
}
