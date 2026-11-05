import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTar, type ExecResult } from '../src/remote.ts'
import { connectSftp, isMissingSftpError, openExecRemote, openRemote, openSftp, remoteFromSftp, remoteFromShell, remoteHostFrom, shellFromClient, type RemoteClient, type SftpLike } from '../src/ssh2-transport.ts'

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

/** Read a tar stream produced by createTar without spawning an external tar. */
function readTar(archive: Buffer): { files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>()
  const dirs: string[] = []
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    const type = header.subarray(156, 157).toString('ascii')
    offset += 512
    if (type === '5') {
      dirs.push(name)
    } else if (type === '0') {
      files.set(name, archive.subarray(offset, offset + size).toString('utf8'))
    }
    offset += Math.ceil(size / 512) * 512
  }
  return { files, dirs }
}

test('createTar writes a POSIX ustar archive without spawning tar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-tar-'))
  mkdirSync(join(dir, 'operator'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), '{"generationId":"gen-1"}')
  writeFileSync(join(dir, 'operator', 'kernel.cpp'), 'void kernel() {}')
  const archive = readTar(createTar(dir))
  expect(archive.files.get('manifest.json')).toBe('{"generationId":"gen-1"}')
  expect(archive.files.get('operator/kernel.cpp')).toBe('void kernel() {}')
  expect(archive.dirs).toContain('operator/')
  // ustar magic is present at offset 257 of the first header.
  expect(createTar(dir).subarray(257, 262).toString('ascii')).toBe('ustar')
})

function shellRecorder(replies: (command: string) => ExecResult = () => ({ code: 0, stdout: '', stderr: '' })) {
  const commands: string[] = []
  return {
    commands,
    shell: {
      async exec(command: string) {
        commands.push(command)
        return replies(command)
      },
    },
  }
}

test('remoteFromShell uploads through exec + base64 tar and removes its temp bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-exec-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  let n = 0
  const recorder = shellRecorder()
  const host = remoteFromShell(recorder.shell, () => {}, () => `token${++n}`)
  await host.uploadDir(dir, '/tmp/canness-a/inbox/gen-1')
  expect(recorder.commands[0]).toContain('mkdir -p --')
  expect(recorder.commands.some(command => command.includes('base64 -d <') && command.includes('tar -xf - -C'))).toBe(true)
  expect(recorder.commands.some(command => command.includes('.canness-upload-token1.b64'))).toBe(true)
  expect(recorder.commands.at(-1)).toContain("rm -f -- '/tmp/canness-a/inbox/.canness-upload-token1.b64'")
  expect(recorder.commands.some(command => command.toLowerCase().includes('sftp'))).toBe(false)
})

test('remoteFromShell reads base64 and treats missing files as null', async () => {
  const recorder = shellRecorder(command => command.startsWith('if [ -f')
    ? (command.includes('/missing') ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: 'aGVsbG8=\n', stderr: '' })
    : { code: 0, stdout: '', stderr: '' })
  const host = remoteFromShell(recorder.shell, () => {})
  expect(Buffer.from((await host.readFile('/present.txt'))!).toString()).toBe('hello')
  await expect(host.readFile('/missing')).resolves.toBeNull()
})

test('remoteFromShell surfaces the first 20 stderr lines of a failed command', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `remote-line-${index + 1}`)
  const recorder = shellRecorder(command => command.startsWith('mkdir -p')
    ? { code: 1, stdout: '', stderr: `${lines.join('\n')}\n` }
    : { code: 0, stdout: '', stderr: '' })
  const host = remoteFromShell(recorder.shell, () => {})
  const failure = await host.mkdirp('/denied').catch((error: Error) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain('remote-line-20')
  expect((failure as Error).message).not.toContain('remote-line-21')
})

test('openExecRemote never requests the SFTP subsystem', async () => {
  let sftpCalls = 0
  const handlers = new Map<string, Function>()
  const client = {
    ends: 0,
    on(event: string, fn: Function) { handlers.set(event, fn); return client },
    connect() { handlers.get('ready')?.(); return client },
    sftp() { sftpCalls += 1 },
    end() { client.ends += 1 },
  }
  const host = await openExecRemote(client as unknown as RemoteClient, dialOpts)
  expect(sftpCalls).toBe(0)
  await host.close()
  expect(client.ends).toBe(1)
})
