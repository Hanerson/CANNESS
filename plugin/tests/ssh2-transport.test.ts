import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { connectSftp, isMissingSftpError, type SftpLike } from '../src/ssh2-transport.ts'

test('uploads a tree and reads a missing file as null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-sftp-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  const stored = new Map<string, Buffer>()
  const sftp: SftpLike = {
    async mkdir() {},
    async fastPut(local, remote) { stored.set(remote, Buffer.from('{}')); expect(local).toContain('manifest.json') },
    async readFile(remote) { return stored.get(remote) ?? null },
  }
  const files = await connectSftp({
    host: 'npu', port: 22, username: 'canness', privateKey: 'KEY',
  }, async () => sftp)
  await files.uploadDir(dir, '/inbox/gen-1')
  expect(stored.has('/inbox/gen-1/manifest.json')).toBe(true)
  expect(await files.readFile('/inbox/gen-1/nope')).toBeNull()
})

test('ssh2 NO_SUCH_FILE and ENOENT are missing, other codes are not', () => {
  expect(isMissingSftpError({ code: 2 })).toBe(true)
  expect(isMissingSftpError({ code: 'ENOENT' })).toBe(true)
  expect(isMissingSftpError({ code: 4 })).toBe(false)
  expect(isMissingSftpError({ code: 'EACCES' })).toBe(false)
  expect(isMissingSftpError({})).toBe(false)
})
