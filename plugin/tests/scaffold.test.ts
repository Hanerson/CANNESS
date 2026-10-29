import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('package declares the dsh bundle and four entries', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.name).toBe('dsh-canness')
  expect(pkg.type).toBe('module')
  expect(pkg.engines.node).toBe('>=24.9.0')
  expect(pkg.engines.dsh).toBe('>=0.2.0 <0.3.0')
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.exports['./knowledge']).toBe('./lib/knowledge.js')
  expect(pkg.exports['./generator']).toBe('./lib/generator.js')
  expect(pkg.exports['./eval']).toBe('./lib/eval.js')
  expect(pkg.exports['./loop']).toBe('./lib/loop.js')
})
