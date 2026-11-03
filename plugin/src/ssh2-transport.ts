import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Client, type SFTPWrapper } from 'ssh2'
import type { ExecResult, RemoteFiles, RemoteHost, RemoteShell, RemoteStat } from './remote.js'

export interface SftpLike {
  mkdir(path: string): Promise<void>
  fastPut(local: string, remote: string): Promise<void>
  readFile(remote: string): Promise<Buffer | null>
  unlink(remote: string): Promise<void>
  stat(remote: string): Promise<RemoteStat | null>
  end(): Promise<void>
}

export interface SftpOptions {
  host: string
  port: number
  username: string
  privateKey?: string
  password?: string
}

export type Dial = (opts: SftpOptions) => Promise<SftpLike>

/**
 * One mkdirp per session with a prefix cache: a slow link pays one round trip
 * per new directory instead of re-probing every ancestor on each upload.
 */
function createMkdirp(sftp: SftpLike): (dir: string) => Promise<void> {
  const known = new Set<string>()
  return async (dir: string) => {
    const parts = dir.split('/').filter(Boolean)
    let acc = dir.startsWith('/') ? '' : '.'
    for (const part of parts) {
      acc += `/${part}`
      if (known.has(acc)) continue
      try {
        await sftp.mkdir(acc)
      } catch (error) {
        // "Already exists" arrives as generic FAILURE (or FILE_ALREADY_EXISTS) on
        // most servers. Anything that is not already a directory — permission
        // denied, a file in the way — must surface, not be swallowed.
        const existing = await sftp.stat(acc).catch(() => null)
        if (!existing?.isDirectory) throw error
      }
      known.add(acc)
    }
  }
}

export function remoteFromSftp(sftp: SftpLike, mkdir: (dir: string) => Promise<void> = createMkdirp(sftp)): RemoteFiles {
  return {
    async uploadDir(localDir, remoteDir) {
      await mkdir(remoteDir)
      const walk = async (dir: string): Promise<void> => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const rel = relative(localDir, full).split('\\').join('/')
          const remote = `${remoteDir}/${rel}`
          if (statSync(full).isDirectory()) {
            await mkdir(remote)
            await walk(full)
          } else {
            await sftp.fastPut(full, remote)
          }
        }
      }
      await walk(localDir)
    },
    readFile: remote => sftp.readFile(remote),
    removeFile: remote => sftp.unlink(remote),
    close: () => sftp.end(),
  }
}

/** Same SFTP session plus the three host operations bootstrap needs. */
export function remoteHostFrom(sftp: SftpLike, shell: RemoteShell): RemoteHost {
  const mkdir = createMkdirp(sftp)
  return {
    ...remoteFromSftp(sftp, mkdir),
    mkdirp: mkdir,
    put: (local, remote) => sftp.fastPut(local, remote),
    stat: remote => sftp.stat(remote),
    exec: command => shell.exec(command),
  }
}

export async function connectSftp(opts: SftpOptions, dial: Dial = defaultDial): Promise<RemoteFiles> {
  return remoteFromSftp(await dial(opts))
}

export async function connectRemote(opts: SftpOptions): Promise<RemoteHost> {
  // Client's event overloads are wider than the ready/error/sftp/exec subset this session uses.
  return openRemote(new Client() as unknown as RemoteClient, opts)
}

export function isMissingSftpError(err: unknown): boolean {
  // ssh2 SFTP sets code to numeric 2 (NO_SUCH_FILE), not the string ENOENT.
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return code === 2 || code === 'ENOENT'
}

interface DialClient {
  on(event: 'ready', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  connect(config: { host: string; port: number; username: string; privateKey?: string; password?: string }): this
  sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): this
  end(): void
}

export interface ShellChannel {
  on(event: 'data' | 'exit' | 'close' | 'error', listener: (...args: any[]) => void): unknown
  stderr: { on(event: 'data', listener: (...args: any[]) => void): unknown }
}

export interface ShellClient {
  exec(command: string, callback: (err: Error | undefined, stream: ShellChannel) => void): void
}

export interface RemoteClient extends DialClient {
  exec(command: string, callback: (err: Error | undefined, stream: ShellChannel) => void): void
}

/** Wraps `client.exec` into one promise per command: stdout/stderr collected, exit code kept. */
export function shellFromClient(client: ShellClient): RemoteShell {
  return {
    exec(command) {
      return new Promise<ExecResult>((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error) {
            reject(error)
            return
          }
          let stdout = ''
          let stderr = ''
          let code = 0
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            resolve({ code, stdout, stderr })
          }
          stream.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
          stream.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
          stream.on('exit', (exitCode: number | null) => {
            if (typeof exitCode === 'number') code = exitCode
          })
          stream.on('close', finish)
          stream.on('error', (streamError: Error) => {
            if (settled) return
            settled = true
            reject(streamError)
          })
        })
      })
    },
  }
}

function sftpLike(sftp: SFTPWrapper, end: () => void): SftpLike {
  return {
    mkdir: path => new Promise((res, rej) => sftp.mkdir(path, err => err ? rej(err) : res())),
    fastPut: (local, remote) => new Promise((res, rej) => sftp.fastPut(local, remote, err => err ? rej(err) : res())),
    readFile: remote => new Promise((res, rej) => {
      sftp.readFile(remote, (err, data) => {
        if (err && isMissingSftpError(err)) res(null)
        else if (err) rej(err)
        else res(data)
      })
    }),
    unlink: remote => new Promise((res, rej) => {
      sftp.unlink(remote, err => {
        if (err && !isMissingSftpError(err)) rej(err)
        else res()
      })
    }),
    stat: remote => new Promise((res, rej) => {
      sftp.stat(remote, (err, stats) => {
        if (err && isMissingSftpError(err)) res(null)
        else if (err) rej(err)
        else res({ isFile: stats.isFile(), isDirectory: stats.isDirectory() })
      })
    }),
    end: async () => { end() },
  }
}

function connectConfig(opts: SftpOptions): { host: string; port: number; username: string; privateKey?: string; password?: string } {
  return {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
    ...(opts.password !== undefined ? { password: opts.password } : {}),
  }
}

/** Opens one SFTP session; `end` is idempotent so `close()` may be called twice safely. */
function openSession<T>(client: DialClient, opts: SftpOptions, build: (sftp: SFTPWrapper, end: () => void) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      client.end()
    }
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          end()
          reject(error)
          return
        }
        resolve(build(sftp, end))
      })
    }).on('error', reject).connect(connectConfig(opts))
  })
}

export function openSftp(client: DialClient, opts: SftpOptions): Promise<SftpLike> {
  return openSession(client, opts, (sftp, end) => sftpLike(sftp, end))
}

export function openRemote(client: RemoteClient, opts: SftpOptions): Promise<RemoteHost> {
  return openSession(client, opts, (sftp, end) => remoteHostFrom(sftpLike(sftp, end), shellFromClient(client)))
}

function defaultDial(opts: SftpOptions): Promise<SftpLike> {
  // Client's event overloads are wider than the ready/error/sftp subset this session uses.
  return openSftp(new Client() as DialClient, opts)
}
