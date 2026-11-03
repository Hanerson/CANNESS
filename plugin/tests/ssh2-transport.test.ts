import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { connectSftp, isMissingSftpError, openRemote, openSftp, remoteFromSftp, remoteHostFrom, shellFromClient, type RemoteClient, type SftpLike } from '../src/ssh2-transport.ts'

test('uploads a tree and reads a missing file as null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-sftp-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  const stored = new Map<string, Buffer>()
  const sftp: SftpLike = {
    async mkdir() {},
    async fastPut(local, remote) { stored.set(remote, Buffer.from('{}')); expect(local).toContain('manifest.json') },
    async readFile(remote) { return stored.get(remote) ?? null },
    async unlink() {},
    async stat() { return null },
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
    connectConfig: undefined as { host?: string; port?: number; username?: string; privateKey?: string; password?: string } | undefined,
    on(event: string, fn: Function) {
      handlers.set(event, fn)
      return client
    },
    connect(config: object) {
      client.connectConfig = config as typeof client.connectConfig
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

test('openSftp passes password auth through and omits the key', async () => {
  const client = fakeClient(cb => {
    cb(undefined, { unlink(_path, done) { done(null) } })
  })
  const files = remoteFromSftp(await openSftp(client, {
    host: 'npu', port: 22, username: 'canness', password: 'pw',
  }))
  expect(client.connectConfig).toMatchObject({ host: 'npu', port: 22, username: 'canness', password: 'pw' })
  expect(client.connectConfig).not.toHaveProperty('privateKey')
  await files.close()
})

test('openSftp keeps passing the private key when present', async () => {
  const client = fakeClient(cb => {
    cb(undefined, { unlink(_path, done) { done(null) } })
  })
  await openSftp(client, { host: 'npu', port: 22, username: 'canness', privateKey: 'KEY' })
  expect(client.connectConfig).toMatchObject({ privateKey: 'KEY' })
  expect(client.connectConfig).not.toHaveProperty('password')
})

function fakeChannel() {
  const handlers = new Map<string, Function>()
  const stderrHandlers = new Map<string, Function>()
  const channel = {
    on(event: string, listener: Function) {
      handlers.set(event, listener)
      return channel
    },
    stderr: {
      on(event: string, listener: Function) {
        stderrHandlers.set(event, listener)
        return this
      },
    },
    emit(event: string, ...args: unknown[]) { handlers.get(event)?.(...args) },
    emitStderr(text: string) { stderrHandlers.get('data')?.(Buffer.from(text)) },
  }
  return channel
}

function fakeShellClient(channel: ReturnType<typeof fakeChannel>) {
  return {
    exec(_command: string, callback: (err: Error | undefined, stream: ReturnType<typeof fakeChannel>) => void) {
      callback(undefined, channel)
    },
  }
}

test('exec collects stdout, stderr and a non-zero exit code', async () => {
  const channel = fakeChannel()
  const shell = shellFromClient(fakeShellClient(channel))
  const pending = shell.exec('cmake .. && make')
  channel.emitStderr('error: missing toolchain\n')
  channel.emit('data', Buffer.from('building\n'))
  channel.emit('exit', 2)
  channel.emit('close')
  await expect(pending).resolves.toEqual({ code: 2, stdout: 'building\n', stderr: 'error: missing toolchain\n' })
})

test('exec defaults to exit code 0 and surfaces channel errors', async () => {
  const channel = fakeChannel()
  const shell = shellFromClient(fakeShellClient(channel))
  const pending = shell.exec('true')
  channel.emit('data', Buffer.from('ok\n'))
  channel.emit('close')
  await expect(pending).resolves.toEqual({ code: 0, stdout: 'ok\n', stderr: '' })

  const refused = shellFromClient({
    exec(_command, callback) { callback(new Error('exec refused'), undefined as never) },
  })
  await expect(refused.exec('nothing')).rejects.toThrow('exec refused')
})

test('mkdirp keeps an existing directory and rethrows a permission error', async () => {
  const calls: string[] = []
  const sftp: SftpLike = {
    async mkdir(path) {
      calls.push(`mkdir ${path}`)
      if (path === '/tmp/exists') throw Object.assign(new Error('Failure'), { code: 4 })
      if (path === '/denied') throw Object.assign(new Error('Permission denied'), { code: 3 })
    },
    async fastPut() {},
    async readFile() { return null },
    async unlink() {},
    async stat(path) {
      calls.push(`stat ${path}`)
      return path === '/tmp/exists' ? { isFile: false, isDirectory: true } : null
    },
    async end() {},
  }
  const host = remoteHostFrom(sftp, { exec: async () => ({ code: 0, stdout: '', stderr: '' }) })
  await expect(host.mkdirp('/tmp/exists')).resolves.toBeUndefined()
  expect(calls).toEqual(['mkdir /tmp', 'mkdir /tmp/exists', 'stat /tmp/exists'])
  // The prefix cache keeps a repeated upload from re-probing every ancestor.
  await expect(host.mkdirp('/tmp/exists')).resolves.toBeUndefined()
  expect(calls).toHaveLength(3)
  await expect(host.mkdirp('/denied')).rejects.toThrow('Permission denied')
})

test('a remote host ends the client once across repeated close calls', async () => {
  const client = fakeClient(cb => {
    cb(undefined, { unlink(_path, done) { done(null) } })
  })
  const host = await openRemote(client as unknown as RemoteClient, dialOpts)
  await host.close()
  await host.close()
  expect(client.ends).toBe(1)
})
