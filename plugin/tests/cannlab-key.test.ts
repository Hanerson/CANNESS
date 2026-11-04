/** The temporary SSH key: where it lands, and whether its permissions are narrow. */

import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writePrivateKey } from '../src/cannlab/connect.js'

/** One throwaway key directory per test. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'canness-key-'))
}

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----'

describe('writePrivateKey', () => {
  it('writes the key under the environment directory with a trailing newline', () => {
    const dir = tempDir()
    const written = writePrivateKey(dir, 'inst-1', KEY, () => true)
    expect(written.restricted).toBe(true)
    expect(written.path.startsWith(join(dir, 'inst-1'))).toBe(true)
    expect(readFileSync(written.path, 'utf8')).toBe(`${KEY}\n`)
  })

  it('reports a permission narrowing that failed instead of failing the connect', () => {
    // Windows keeps the inherited ACL after a 0600 write, and an external ssh
    // then refuses the file. That must surface, but never throw: the tunnel
    // already works through ssh2.
    const written = writePrivateKey(tempDir(), 'inst-2', KEY, () => false)
    expect(written.restricted).toBe(false)
    expect(readFileSync(written.path, 'utf8')).toBe(`${KEY}\n`)
  })

  it('keeps the file owner-readable only, on a platform whose mode decides it', () => {
    if (process.platform === 'win32') return
    const written = writePrivateKey(tempDir(), 'inst-3', KEY)
    expect(written.restricted).toBe(true)
    expect(statSync(written.path).mode & 0o777).toBe(0o600)
  })

  it('never reuses a key path between two connects', () => {
    const dir = tempDir()
    const first = writePrivateKey(dir, 'inst-4', KEY, () => true)
    const second = writePrivateKey(dir, 'inst-4', KEY, () => true)
    expect(first.path).not.toBe(second.path)
  })
})
