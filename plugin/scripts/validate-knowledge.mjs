import { loadKnowledgeEntries } from '../src/knowledge-entry.ts'

const root = process.argv[2] ?? new URL('../knowledge_base/', import.meta.url)
try {
  const entries = loadKnowledgeEntries(root)
  console.log(`Validated ${entries.length} structured knowledge entries.`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
