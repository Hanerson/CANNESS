import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'
import { contractFingerprint } from '../src/package-files.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'canness-fingerprint-'))
  for (const dir of ['src', 'lib', 'templates/build-contract']) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'test' }))
  writeFileSync(join(root, 'src/package-files.ts'), 'source code')
  writeFileSync(join(root, 'lib/package-files.js'), 'built code')
  writeFileSync(join(root, 'templates/build-contract/main.cpp'), 'template')
  return { root, fingerprint: (dir: string) => contractFingerprint(pathToFileURL(join(root, dir, `package-files.${dir === 'src' ? 'ts' : 'js'}`)).href) }
}

test('fingerprint identifies executing source even when lib exists and hashes template bytes', () => {
  const { root, fingerprint } = fixture()
  const original = fingerprint('src')
  const built = fingerprint('lib')
  writeFileSync(join(root, 'lib/package-files.js'), 'irrelevant stale lib')
  expect(fingerprint('src').libHash).toBe(original.libHash)
  expect(fingerprint('lib').libHash).not.toBe(built.libHash)
  writeFileSync(join(root, 'src/package-files.ts'), 'changed source')
  expect(fingerprint('src').libHash).not.toBe(original.libHash)
  writeFileSync(join(root, 'templates/build-contract/main.cpp'), 'changed template')
  expect(fingerprint('src').templatesHash).not.toBe(original.templatesHash)
  expect(fingerprint('src').codeSource).toBe('src')
})

test('lib execution exposes stale build warning with actionable rebuild command', () => {
  const { root, fingerprint } = fixture()
  utimesSync(join(root, 'lib/package-files.js'), 100, 100)
  utimesSync(join(root, 'src/package-files.ts'), 200, 200)
  expect(fingerprint('lib')).toMatchObject({ codeSource: 'lib', staleBuild: true })
  expect(fingerprint('lib').warnings.join(' ')).toContain('pnpm build')
  expect(fingerprint('src').warnings).toEqual([])
})

test('distributed lib without sources produces no stale warning', () => {
  const { root } = fixture()
  // Model a shipped package whose runtime has no sibling source tree.
  const shipped = join(root, 'shipped')
  mkdirSync(join(shipped, 'lib'), { recursive: true })
  mkdirSync(join(shipped, 'templates/build-contract'), { recursive: true })
  writeFileSync(join(shipped, 'package.json'), '{"version":"test"}')
  writeFileSync(join(shipped, 'lib/package-files.js'), 'built')
  writeFileSync(join(shipped, 'templates/build-contract/main.cpp'), 'template')
  expect(contractFingerprint(pathToFileURL(join(shipped, 'lib/package-files.js')).href)).toMatchObject({ staleBuild: false, warnings: [] })
})


test('a source module absent from lib is diagnosed as an incomplete build', () => {
  const { root, fingerprint } = fixture()
  writeFileSync(join(root, 'src/new-module.ts'), 'export const fresh = true')
  expect(fingerprint('lib').staleBuild).toBe(true)
  expect(fingerprint('lib').warnings.join(' ')).toContain('new-module.ts')
})
