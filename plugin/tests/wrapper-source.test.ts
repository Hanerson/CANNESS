import { expect, test } from 'vitest'
import { checkWrapperSource } from '../src/wrapper-source.ts'

const signature = 'op(x, layout=0)'
const good = [
  'def op(x, layout=0):',
  '    """Rotate."""',
  '    return x',
].join('\n')

test('a wrapper that matches the declared signature passes', () => {
  const check = checkWrapperSource(good, 'op', signature)
  expect(check.mode).toBe('python')
  expect(check.warnings).toEqual([])
})

test('a syntax error is reported with its location', () => {
  expect(() => checkWrapperSource('def op(x, layout=0)\n    return x\n', 'op', signature))
    .toThrow(/does not parse/)
})

test('a missing callable is rejected', () => {
  expect(() => checkWrapperSource('def other(x, layout=0):\n    return x\n', 'op', signature))
    .toThrow(/must define op exactly once/)
})

test('a duplicated callable is rejected', () => {
  const duplicated = `${good}\n\ndef op(x, layout=0):\n    return x\n`
  expect(() => checkWrapperSource(duplicated, 'op', signature))
    .toThrow(/exactly once/)
})

test('a signature that differs from the declaration is rejected', () => {
  expect(() => checkWrapperSource('def op(x):\n    return x\n', 'op', signature))
    .toThrow(/signature differs/)
})

test('an asynchronous callable is rejected', () => {
  expect(() => checkWrapperSource('async def op(x, layout=0):\n    return x\n', 'op', signature))
    .toThrow(/exactly once|signature differs/)
})

test('an empty wrapper is rejected', () => {
  expect(() => checkWrapperSource('   ', 'op', signature)).toThrow(/empty/)
})
