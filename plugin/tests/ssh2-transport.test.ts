import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { connectSftp, isMissingSftpError, openSftp, remoteFromSftp, type SftpLike } from '../src/ssh2-transport.ts'

test('uploads a tree and reads a missing file as null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-sftp-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  const stored = new Map<string, Buffer>()
  const sftp: SftpLike = {
    async mkdir() {},
    async fastPut(local, remote) { stored.set(remote, Buffer.from('{}')); expect(local).toContain('manifest.json') },
    async readFile(remote) { return stored.get(remote) ?? null },
    async unlink() {},
    async end() {},
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

const dialOpts = { host: 'npu', port: 22, username: 'canness', privateKey: 'KEY' }

function fakeClient(start: (cb: (err: Error | undefined, sftp: { unlink: (path: string, done: (err?: Error | null) => void) => void }) => void) => void) {
  const handlers = new Map<string, Function>()
  const client = {
    ends: 0,
    on(event: string, fn: Function) {
      handlers.set(event, fn)
      return client
    },
    connect() {
      handlers.get('ready')?.()
      return client
    },
    sftp(cb: (err: Error | undefined, sftp: { unlink: (path: string, done: (err?: Error | null) => void) => void }) => void) {
      start(cb)
    },
    end() {
      client.ends += 1
    },
  }
  return client
}

test('removeFile treats NO_SUCH_FILE and ENOENT as success and close ends the client', async () => {
  const client = fakeClient(cb => {
    cb(undefined, {
      unlink(path, done) {
        if (path === '/missing') done(Object.assign(new Error('missing'), { code: 2 }))
        else if (path === '/enoent') done(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        else done(Object.assign(new Error('denied'), { code: 4 }))
      },
    })
  })
  const files = remoteFromSftp(await openSftp(client, dialOpts))
  await expect(files.removeFile('/missing')).resolves.toBeUndefined()
  await expect(files.removeFile('/enoent')).resolves.toBeUndefined()
  await expect(files.removeFile('/denied')).rejects.toThrow('denied')
  expect(client.ends).toBe(0)
  await files.close()
  expect(client.ends).toBe(1)
})

test('a failed sftp() ends the client', async () => {
  const client = fakeClient(cb => { cb(new Error('sftp failed'), undefined as never) })
  await expect(openSftp(client, dialOpts)).rejects.toThrow('sftp failed')
  expect(client.ends).toBe(1)
})
