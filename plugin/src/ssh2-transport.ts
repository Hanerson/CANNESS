import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Client } from 'ssh2'
import type { RemoteFiles } from './remote.ts'

export interface SftpLike {
  mkdir(path: string): Promise<void>
  fastPut(local: string, remote: string): Promise<void>
  readFile(remote: string): Promise<Buffer | null>
}

export interface SftpOptions {
  host: string
  port: number
  username: string
  privateKey: string
}

export type Dial = (opts: SftpOptions) => Promise<SftpLike>

async function mkdirp(sftp: SftpLike, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean)
  let acc = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    acc += `/${part}`
    try { await sftp.mkdir(acc) } catch { /* already exists */ }
  }
}

export function remoteFromSftp(sftp: SftpLike): RemoteFiles {
  return {
    async uploadDir(localDir, remoteDir) {
      await mkdirp(sftp, remoteDir)
      const walk = async (dir: string): Promise<void> => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const rel = relative(localDir, full).split('\\').join('/')
          const remote = `${remoteDir}/${rel}`
          if (statSync(full).isDirectory()) {
            await mkdirp(sftp, remote)
            await walk(full)
          } else {
            await sftp.fastPut(full, remote)
          }
        }
      }
      await walk(localDir)
    },
    readFile: remote => sftp.readFile(remote),
  }
}

export async function connectSftp(opts: SftpOptions, dial: Dial = defaultDial): Promise<RemoteFiles> {
  return remoteFromSftp(await dial(opts))
}

export function isMissingSftpError(err: unknown): boolean {
  // ssh2 SFTP sets code to numeric 2 (NO_SUCH_FILE), not the string ENOENT.
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  return code === 2 || code === 'ENOENT'
}

function defaultDial(opts: SftpOptions): Promise<SftpLike> {
  const client = new Client()
  return new Promise((resolve, reject) => {
    client.on('ready', () => {
      client.sftp((error, sftp) => {
        if (error) { reject(error); return }
        resolve({
          mkdir: path => new Promise((res, rej) => sftp.mkdir(path, err => err ? rej(err) : res())),
          fastPut: (local, remote) => new Promise((res, rej) => sftp.fastPut(local, remote, err => err ? rej(err) : res())),
          readFile: remote => new Promise((res, rej) => {
            sftp.readFile(remote, (err, data) => {
              if (err && isMissingSftpError(err)) res(null)
              else if (err) rej(err)
              else res(data)
            })
          }),
        })
      })
    }).on('error', reject).connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      privateKey: opts.privateKey,
    })
  })
}
