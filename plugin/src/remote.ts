import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, posix } from 'node:path'

/** Single-quote a value for POSIX sh; embedded quotes become `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** First `count` lines of remote stderr, flattened into one reportable string. */
export function firstLines(text: string, count = 20): string {
  return text.split(/\r?\n/).filter(line => line.trim() !== '').slice(0, count).join('\n')
}

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
 * A transport that can execute commands, prepare directories, and transfer
 * single files. The exec+base64 tar upload path and the runner both need this;
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

/* ------------------------------------------------------------------------- *
 * Pure-JS POSIX tar writer.
 *
 * The local sandbox refuses `spawnSync('tar')` with EPERM, so the upload
 * bundle is built in-process. The remote side extracts it with the host's own
 * `tar -xf`, which only needs a POSIX tar stream — no gzip and no SFTP.
 * ------------------------------------------------------------------------- */

const TAR_BLOCK = 512
const TAR_CHUNK_CHARS = 48 * 1024

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Split a long path into ustar's 155-byte prefix and 100-byte name. */
function splitUstarPath(full: string): { name: string; prefix: string } {
  if (byteLength(full) <= 100) return { name: full, prefix: '' }
  for (let index = full.length - 1; index > 0; index -= 1) {
    if (full[index] !== '/') continue
    const prefix = full.slice(0, index)
    const name = full.slice(index + 1)
    if (byteLength(prefix) <= 155 && byteLength(name) <= 100) return { name, prefix }
  }
  throw new Error(`path too long for a POSIX tar header: ${full}`)
}

function writeAscii(target: Buffer, offset: number, length: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8')
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0').slice(-(length - 1))
  target.write(`${text}\0`, offset, length, 'ascii')
}

interface TarHeaderInput {
  path: string
  type: '0' | '5'
  mode: number
  size: number
  mtime: number
}

function tarHeader(input: TarHeaderInput): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0)
  const { name, prefix } = splitUstarPath(input.path)
  writeAscii(header, 0, 100, name)
  writeOctal(header, 100, 8, input.mode)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, input.size)
  writeOctal(header, 136, 12, input.mtime)
  header.fill(0x20, 148, 156)
  writeAscii(header, 156, 1, input.type)
  writeAscii(header, 257, 6, 'ustar\0')
  writeAscii(header, 263, 2, '00')
  writeAscii(header, 345, 155, prefix)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function padToBlock(size: number): number {
  const remainder = size % TAR_BLOCK
  return remainder === 0 ? 0 : TAR_BLOCK - remainder
}

/**
 * Build a POSIX ustar archive of a local directory.
 *
 * File contents are read in-process; no external `tar` process is spawned
 * (sandboxed hosts reject child-process pipes with EPERM). Symlinks and other
 * non-file entries are skipped — test packages are plain source trees.
 * @param localDir - directory whose contents become the archive root.
 * @returns the complete tar stream, including the two end-of-archive blocks.
 */
export function createTar(localDir: string): Buffer {
  const blocks: Buffer[] = []
  const walk = (dir: string): void => {
    const names = readdirSync(dir).sort()
    for (const name of names) {
      const full = join(dir, name)
      const rel = relative(localDir, full).split('\\').join('/')
      const stats = statSync(full)
      if (stats.isDirectory()) {
        blocks.push(tarHeader({ path: `${rel}/`, type: '5', mode: 0o755, size: 0, mtime: stats.mtimeMs / 1000 }))
        walk(full)
        continue
      }
      if (!stats.isFile()) continue
      const body = readFileSync(full)
      blocks.push(tarHeader({ path: rel, type: '0', mode: 0o644, size: body.length, mtime: stats.mtimeMs / 1000 }))
      blocks.push(body)
      const padding = padToBlock(body.length)
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0))
    }
  }
  walk(localDir)
  blocks.push(Buffer.alloc(TAR_BLOCK * 2, 0))
  return Buffer.concat(blocks)
}

/**
 * Shell commands that write a byte stream to a remote file through base64.
 * The first command truncates the target, the rest append, keeping every
 * command line well below a typical 128 KiB ARG_MAX.
 * @param remotePath - destination file, quoted by the caller-provided quoter.
 * @param bytes - payload to encode.
 * @returns POSIX sh commands to run in order.
 */
export function base64WriteCommands(remotePath: string, bytes: Uint8Array): string[] {
  const encoded = Buffer.from(bytes).toString('base64')
  const commands: string[] = []
  const quoted = shellQuote(remotePath)
  for (let offset = 0; offset < encoded.length || commands.length === 0; offset += TAR_CHUNK_CHARS) {
    const chunk = encoded.slice(offset, offset + TAR_CHUNK_CHARS)
    const operator = commands.length === 0 ? '>' : '>>'
    commands.push(`printf '%s' ${shellQuote(chunk)} ${operator} ${quoted}`)
  }
  return commands
}

/** Remote directory that holds one generation's upload bundle. */
export function remoteUploadBundlePath(baseDir: string, token: string): string {
  return posix.join(baseDir, `.canness-upload-${token}.b64`)
}

/** Remote path for a temporary single-file transfer. */
export function remoteFileBundlePath(baseDir: string, token: string): string {
  return posix.join(baseDir, `.canness-file-${token}.b64`)
}
