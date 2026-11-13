import { expect, test } from 'vitest'
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
