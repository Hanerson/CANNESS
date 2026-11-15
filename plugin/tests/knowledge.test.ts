import { expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/knowledge.ts'
import { searchKnowledge } from '../src/knowledge-search.ts'

test('returns the add note and a miss message', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  expect(searchKnowledge(root, 'Add')).toContain('float16')
  expect(searchKnowledge(root, 'MissingOp')).toBe('no knowledge entry for MissingOp')
})

test('caps the body at 8000 characters', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  expect(searchKnowledge(root, 'Add').length).toBeLessThanOrEqual(8000)
})

test('ArgMax and WholeReduce knowledge entries are discoverable', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  expect(searchKnowledge(root, 'ArgMax')).toContain('WholeReduce')
  expect(searchKnowledge(root, 'WholeReduce')).toContain('repeatTimes')
  expect(searchKnowledge(root, 'WholeReduce')).toContain('64')
})

function withKnowledgeRoot(run: (root: string, add: ReturnType<typeof fixtureWriter>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'canness-kb-'))
  mkdirSync(join(root, 'entries'))
  return run(root, fixtureWriter(root)).finally(() => rmSync(root, { recursive: true, force: true }))
}

function fixtureWriter(root: string) {
  return (id: string, metadata: Record<string, unknown> = {}, body = 'Fixture body.') => {
    const header = {
      schema_version: 1, id, title: id, kind: 'implementation',
      operator: 'FixtureReduce', aliases: ['SyntheticReduce'],
      evidence: 'source_inspection', sources: [{ ref: 'fixture.cpp#reduce' }], ...metadata,
    }
    writeFileSync(join(root, 'entries', `${id}.md`), `---\n${JSON.stringify(header)}\n---\n${body}\n`)
  }
}

function toolFor(root: string) {
  let tool!: { execute: (args: Record<string, unknown>) => Promise<unknown> }
  apply({ tools: { register(value: typeof tool) { tool = value } } } as never, { kbRoot: root })
  return tool
}

test('kb_search accepts the legacy call and returns its text', async () => {
  const tool = toolFor(fileURLToPath(new URL('../knowledge_base/', import.meta.url)))
  await expect(tool.execute({ operator_name: 'Add' })).resolves.toContain('float16')
  await expect(tool.execute({ operator_name: 'MissingOp' })).resolves.toBe('no knowledge entry for MissingOp')
})

test('structured search ranks matching passages and excludes conflicting applicability', () =>
  withKnowledgeRoot(async (root, add) => {
    add('applicable', {
      title: '跨步归约 TileReduce', hardware: ['950pr'], dtypes: ['bf16'], layouts: ['strided'],
      cann_versions: ['9.0.0'],
    })
    add('generic', { keywords: ['归约'] }, '跨步归约 TileReduce')
    add('wrong-hardware', { title: '跨步归约 TileReduce', hardware: ['910b'] })
    add('wrong-layout', { title: '跨步归约 TileReduce', layouts: ['contiguous'] })
    add('wrong-dtype', { title: '跨步归约 TileReduce', dtypes: ['fp32'] })
    add('wrong-operator', { title: '跨步归约 TileReduce', operator: 'AnotherOp', aliases: undefined })
    add('wrong-kind', { title: '跨步归约 TileReduce', kind: 'contract' })
    add('wrong-version', { title: '跨步归约 TileReduce', cann_versions: ['8.0.0'] })
    const tool = toolFor(root)
    await expect(tool.execute({
      operator_name: 'synthetic_reduce', query: '跨步归约 TileReduce', hardware: '950PR',
      dtype: 'bfloat16', layout: 'strided', kind: 'implementation', cann_version: '9.0.0',
    })).resolves.toMatchObject({
      schema_version: 1, has_more: false, hits: [
        { id: 'applicable', evidence: 'source_inspection', sources: [{ ref: 'fixture.cpp#reduce' }] },
        { id: 'generic', body: '跨步归约 TileReduce' },
      ],
    })
    await expect(tool.execute({ operator_name: 'fixture_reduce' })).resolves.toContain('Fixture body.')
  }))

test('queries can find a shared primitive without confusing it with another operator', () =>
  withKnowledgeRoot(async (root, add) => {
    add('shared', { title: 'TileReduce', operator: undefined, aliases: undefined })
    add('specific', { title: 'TileReduce' })
    const tool = toolFor(root)
    await expect(tool.execute({ operator_name: 'FixtureReduce', query: 'TileReduce' })).resolves.toMatchObject({
      hits: [{ id: 'specific' }, { id: 'shared' }],
    })
    await expect(tool.execute({ operator_name: 'AnotherOp', limit: 1 })).resolves.toMatchObject({ hits: [] })
  }))

test('structured search handles query-only, misses, limits and invalid queries', () =>
  withKnowledgeRoot(async (root, add) => {
    add('beta', { title: 'TileReduce' })
    add('alpha', { title: 'TileReduce' })
    const tool = toolFor(root)
    await expect(tool.execute({ query: 'TileReduce', limit: 1 })).resolves.toMatchObject({
      has_more: true, hits: [{ id: 'alpha' }],
    })
    await expect(tool.execute({ operator_name: 'FixtureReduce', query: 'Nothing' })).resolves.toEqual({
      schema_version: 1, has_more: false, hits: [],
    })
    await expect(tool.execute({ hardware: '950pr' })).rejects.toThrow(/operator_name or query/)
    await expect(tool.execute({ query: 'TileReduce', limit: 0 })).rejects.toThrow()
  }))

test('structured search keeps full entries within the output budget', () =>
  withKnowledgeRoot(async (root, add) => {
    for (let i = 0; i < 8; i++) add(`entry-${i}`, { title: 'TileReduce' }, 'x'.repeat(1800))
    const result = await toolFor(root).execute({ query: 'TileReduce', limit: 8 }) as {
      hits: Array<{ body: string }>
      has_more: boolean
    }
    expect(result.hits.length).toBeGreaterThan(1)
    expect(result.has_more).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(8000)
    expect(result.hits.every(hit => hit.body.length === 1800)).toBe(true)
  }))

test('invalid knowledge identifies the file and field', () =>
  withKnowledgeRoot(async (root, add) => {
    add('bad-entry', { evidence: 'unverified-value' })
    await expect(toolFor(root).execute({ query: 'TileReduce' })).rejects.toThrow(/bad-entry\.md.*evidence/)
  }))
