import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('package declares the dsh bundle and four entries', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.name).toBe('dsh-canness')
  expect(pkg.type).toBe('module')
  expect(pkg.engines.node).toBe('>=24.9.0')
  expect(pkg.engines.dsh).toBe('>=0.2.0 <0.3.0')
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.exports['.']).toBe('./lib/index.js')
  expect(pkg.exports['./knowledge']).toBe('./lib/knowledge.js')
  expect(pkg.exports['./generator']).toBe('./lib/generator.js')
  expect(pkg.exports['./eval']).toBe('./lib/eval.js')
  expect(pkg.exports['./loop']).toBe('./lib/loop.js')
  expect(pkg.exports['./client']).toBe('./lib/client.js')
  expect(pkg.dsh.client.platform).toBe('web')
  expect(pkg.dsh.client.inject).toEqual([
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-api-remotes',
  ])
})

test('the patch carries the bare package row for the client half', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  expect(patch).toContain('- id: canness\n      name: dsh-canness\n')
})
