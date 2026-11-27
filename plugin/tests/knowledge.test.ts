import { expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../src/knowledge.ts'
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

test('operator-name lookups prefer a structured entry over the legacy notes', () => {
  const root = new URL('../knowledge_base/', import.meta.url)
  // ArgMax has a structured entry, so the compatibility text is the entry:
  // metadata, sources and body, not the old note that happened to mention
  // WholeReduce.
  const argmax = searchKnowledge(root, 'ArgMax')
  expect(argmax).toContain('argmax-950pr-stale-build-not-recompiled')
  expect(argmax).toContain('rm -rf build dist')
  expect(argmax).not.toContain('repeatTimes')
  // WholeReduce has no structured entry, so the fallback still serves the note.
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

function toolFor(root?: string, workspace?: string) {
  let tool!: { execute: (args: Record<string, unknown>) => Promise<unknown> }
  apply({ tools: { register(value: typeof tool) { tool = value } } } as never, Config({ kbRoot: root, workspace }))
  return tool
}

test('uses the installed knowledge base from a working directory outside the package', () =>
  withKnowledgeRoot(async (outside) => {
    const cwd = process.cwd()
    try {
      process.chdir(outside)
      await expect(toolFor().execute({ operator_name: 'Exp' })).resolves.toContain('exp-950pr-base-scale-shift-formula')
    } finally {
      process.chdir(cwd)
    }
  }))

test('an explicit missing root is diagnosed with its resolved path', async () => {
  const root = fileURLToPath(new URL('../not-a-knowledge-base/', import.meta.url))
  await expect(toolFor(root).execute({ operator_name: 'Exp' })).rejects.toThrow(
    expect.objectContaining({ message: expect.stringContaining('Knowledge base root') }),
  )
  await expect(toolFor(root).execute({ operator_name: 'Exp' })).rejects.toThrow(
    expect.objectContaining({ message: expect.stringContaining(resolve(root)) }),
  )
})

test('a legacy probe with mixed evidence is still searchable as a reported note', () =>
  withKnowledgeRoot(async (workspace) => {
    const root = join(workspace, '.canness', 'probe-knowledge')
    mkdirSync(join(root, 'entries'), { recursive: true })
    fixtureWriter(root)('probe-11111111-1111-1111-1111-111111111111', {
      kind: 'troubleshooting', evidence: 'reproduced',
    }, 'Caller claim.\n\nProbe result: pass. Toolchain: unknown.\nMaximum relative error: 0.')
    await expect(toolFor(workspace, workspace).execute({ query: 'Caller claim', include_probes: true })).resolves.toMatchObject({
      hits: [{ evidence: 'reported', body: expect.stringContaining('Caller claim') }],
    })
  }))

test.each([
  ['Exp', 'exp-950pr-base-scale-shift-formula'],
  ['ArgMax', 'argmax-950pr-tie-first-index-nan'],
  ['GQA', 'gqa-950pr-golden-shape-scale-causal'],
])('finds only the portable %s contract in a 910B2 search', async (operator_name, id) => {
  const tool = toolFor(fileURLToPath(new URL('../knowledge_base/', import.meta.url)))
  const result = await tool.execute({ operator_name, hardware: 'Ascend910B2' })
  expect(result).toMatchObject({ has_more: false, hits: [{ id, evidence: 'specification' }] })
  const { hits } = result as { hits: { hardware?: string[]; body: string }[] }
  expect(hits[0].hardware).toBeUndefined()
  expect(hits[0].body).toContain('硬件实测')
})

test('hardware aliases preserve exact parts and family lookups retain the declared scope', () =>
  withKnowledgeRoot(async (root, add) => {
    add('b2', { hardware: ['Ascend910B2'] })
    add('b4', { hardware: ['910B4'] })
    add('family', { hardware: ['910B'] })
    add('pr', { hardware: ['Ascend950PR'] })
    const tool = toolFor(root)
    const search = (hardware: string) => tool.execute({ operator_name: 'FixtureReduce', hardware })
    await expect(search('910b2')).resolves.toMatchObject({ hits: [{ id: 'b2', hardware: ['Ascend910B2'] }] })
    await expect(search('Ascend 910B4')).resolves.toMatchObject({ hits: [{ id: 'b4', hardware: ['910B4'] }] })
    await expect(search('910B')).resolves.toMatchObject({
      hits: [{ id: 'family', hardware: ['910B'] }, { id: 'b2', hardware: ['Ascend910B2'] }, { id: 'b4', hardware: ['910B4'] }],
    })
    await expect(search('950pr')).resolves.toMatchObject({ hits: [{ id: 'pr', hardware: ['Ascend950PR'] }] })
  }))

test('the measured host-copy baseline appears only in its recorded hardware and CANN scope', async () => {
  const tool = toolFor()
  const search = (hardware: string, cann_version: string) => tool.execute({
    query: 'aclrtMemcpy', kind: 'benchmark', hardware, cann_version,
  }) as Promise<{ hits: { id: string }[] }>
  const hasBaseline = ({ hits }: { hits: { id: string }[] }) =>
    hits.some(hit => hit.id === 'cannbench-host-copy-baseline-measured')
  expect(hasBaseline(await search('910b2', '9.2.1'))).toBe(true)
  expect(hasBaseline(await search('Ascend910B4', '9.2.1'))).toBe(false)
  expect(hasBaseline(await search('910b2', '9.0.0'))).toBe(false)
})

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
