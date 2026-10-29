import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

export interface RemoteFiles {
  uploadDir(localDir: string, remoteDir: string): Promise<void>
  readFile(remotePath: string): Promise<Uint8Array | null>
  removeFile(remotePath: string): Promise<void>
  close(): Promise<void>
}

export interface WaitOptions {
  timeoutMs: number
  intervalMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class MemoryRemote implements RemoteFiles {
  readonly files = new Map<string, Uint8Array>()
  reads = 0
  private staged: { path: string; bytes: Uint8Array; onRead: number } | null = null

  appearOnRead(path: string, bytes: Uint8Array, onRead: number): void {
    this.staged = { path, bytes, onRead }
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        const rel = relative(localDir, full).split('\\').join('/')
        this.files.set(posix.join(remoteDir, rel), new Uint8Array(readFileSync(full)))
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
