import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

export interface RemoteFiles {
  uploadDir(localDir: string, remoteDir: string): Promise<void>
  readFile(remotePath: string): Promise<Uint8Array | null>
  removeFile(remotePath: string): Promise<void>
  close(): Promise<void>
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs one command through the remote login shell (POSIX). */
export interface RemoteShell {
  exec(command: string): Promise<ExecResult>
}

export interface RemoteStat {
  isFile: boolean
  isDirectory: boolean
}

/**
 * A transport that can also prepare the remote side. Bootstrap needs this;
 * a plain `RemoteFiles` still supports the upload-and-wait flow.
 */
export interface RemoteHost extends RemoteFiles, RemoteShell {
  mkdirp(remoteDir: string): Promise<void>
  put(localPath: string, remotePath: string): Promise<void>
  stat(remotePath: string): Promise<RemoteStat | null>
}

export function isRemoteHost(files: RemoteFiles): files is RemoteHost {
  const candidate = files as Partial<RemoteHost>
  return typeof candidate.mkdirp === 'function'
    && typeof candidate.put === 'function'
    && typeof candidate.stat === 'function'
    && typeof candidate.exec === 'function'
}

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Every prefix of a POSIX path, used to keep `stat` answerable for mkdirp. */
function ancestors(dir: string): string[] {
  const parts = dir.split('/').filter(Boolean)
  const list: string[] = []
  let acc = dir.startsWith('/') ? '' : '.'
  for (const part of parts) {
    acc += `/${part}`
    list.push(acc)
  }
  return list
}

export type MemoryExecHandler = (command: string) => ExecResult | Promise<ExecResult>

export class MemoryRemote implements RemoteHost {
  readonly files = new Map<string, Uint8Array>()
  readonly dirs = new Set<string>()
  readonly execCalls: string[] = []
  readonly puts: Array<{ localPath: string; remotePath: string }> = []
  execHandler: MemoryExecHandler = () => ({ code: 0, stdout: '', stderr: '' })
  reads = 0
  private staged: { path: string; bytes: Uint8Array; onRead: number } | null = null

  appearOnRead(path: string, bytes: Uint8Array, onRead: number): void {
    this.staged = { path, bytes, onRead }
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    for (const dir of ancestors(remoteDir)) this.dirs.add(dir)
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        const rel = relative(localDir, full).split('\\').join('/')
        const remote = posix.join(remoteDir, rel)
        this.files.set(remote, new Uint8Array(readFileSync(full)))
        for (const parent of ancestors(posix.dirname(remote))) this.dirs.add(parent)
      }
    }
    walk(localDir)
  }

  async readFile(remotePath: string): Promise<Uint8Array | null> {
    this.reads += 1
    if (this.staged && this.reads >= this.staged.onRead && remotePath === this.staged.path) {
      this.files.set(this.staged.path, this.staged.bytes)
    }
    return this.files.get(remotePath) ?? null
  }

  async removeFile(remotePath: string): Promise<void> {
    this.files.delete(remotePath)
  }

  async mkdirp(remoteDir: string): Promise<void> {
    for (const dir of ancestors(remoteDir)) this.dirs.add(dir)
  }

  async put(localPath: string, remotePath: string): Promise<void> {
    this.files.set(remotePath, new Uint8Array(readFileSync(localPath)))
    this.puts.push({ localPath, remotePath })
    for (const dir of ancestors(posix.dirname(remotePath))) this.dirs.add(dir)
  }

  async stat(remotePath: string): Promise<RemoteStat | null> {
    if (this.files.has(remotePath)) return { isFile: true, isDirectory: false }
    if (this.dirs.has(remotePath)) return { isFile: false, isDirectory: true }
    return null
  }

  async exec(command: string): Promise<ExecResult> {
    this.execCalls.push(command)
    return this.execHandler(command)
  }

  async close(): Promise<void> {}
}

export async function waitForRemoteFile(files: RemoteFiles, remotePath: string, opts: WaitOptions): Promise<Uint8Array> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const start = now()
  for (;;) {
    const body = await files.readFile(remotePath)
    if (body) return body
    if (now() - start >= opts.timeoutMs) throw new Error('timeout')
    await sleep(opts.intervalMs)
  }
}
