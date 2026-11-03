import { expect, test } from 'vitest'
import { MemoryRemote, type ExecResult } from '../src/remote.ts'
import { ensureRemoteConsumer, pidAliveCommand, shellQuote } from '../src/remote-bootstrap.ts'

const ok: ExecResult = { code: 0, stdout: '', stderr: '' }
const fail: ExecResult = { code: 1, stdout: '', stderr: '' }

const base = {
  inbox: '/tmp/canness/inbox',
  outbox: '/tmp/canness/outbox',
  command: '',
  enabled: true,
}

function remoteWith(handler: (command: string) => ExecResult): MemoryRemote {
  const remote = new MemoryRemote()
  remote.execHandler = handler
  return remote
}

const isPgrep = (command: string): boolean => command.startsWith('pgrep')
const isPythonProbe = (command: string): boolean => command.startsWith('command -v')
const isStart = (command: string): boolean => command.includes('nohup')
const isKill = (command: string): boolean => command.startsWith('kill -0')

/** A host where every probe finds nothing and the mock consumer starts and stays alive. */
function freshHost(): MemoryRemote {
  return remoteWith(command => {
    if (isPgrep(command)) return fail
    if (isPythonProbe(command)) return { code: 0, stdout: '/usr/bin/python3\n', stderr: '' }
    if (isStart(command)) return ok
    if (isKill(command)) return ok
    return fail
  })
}

test('creates both remote directories before running a bootstrap command', async () => {
  const remote = remoteWith(command => isPgrep(command) ? fail : ok)
  const result = await ensureRemoteConsumer(remote, { ...base, command: 'sh /opt/runner/start.sh' })
  expect(result).toEqual({ ok: true, consumer: 'command' })
  expect(remote.dirs.has('/tmp/canness/inbox')).toBe(true)
  expect(remote.dirs.has('/tmp/canness/outbox')).toBe(true)
  expect(remote.execCalls).toContain('sh /opt/runner/start.sh')
})

test('a live pid file reuses the consumer without starting anything', async () => {
  const remote = remoteWith(command => isKill(command) ? ok : fail)
  remote.files.set('/tmp/canness/watch.pid', Buffer.from('4321'))
  const result = await ensureRemoteConsumer(remote, base)
  expect(result).toEqual({ ok: true, consumer: 'reused' })
  expect(remote.execCalls.some(isStart)).toBe(false)
  expect(remote.execCalls.some(isPgrep)).toBe(false)
  expect(remote.puts).toEqual([])
})

test('pgrep matching a running watch.py reuses the consumer', async () => {
  const remote = remoteWith(command => isPgrep(command) ? ok : fail)
  const result = await ensureRemoteConsumer(remote, base)
  expect(result).toEqual({ ok: true, consumer: 'reused' })
  expect(remote.execCalls).toContain("pgrep -f '[w]atch.py'")
  expect(remote.execCalls.some(isStart)).toBe(false)
  expect(remote.files.size).toBe(0)
})

test('a bare remote gets watch.py uploaded and the mock consumer started', async () => {
  const remote = freshHost()
  const result = await ensureRemoteConsumer(remote, base)
  expect(result).toEqual({ ok: true, consumer: 'started' })
  const body = Buffer.from(remote.files.get('/tmp/canness/watch.py') ?? []).toString('utf8')
  expect(body).toContain('def scan')
  expect(remote.puts.map(put => put.remotePath)).toEqual(['/tmp/canness/watch.py'])
  expect(remote.puts[0]!.localPath.replace(/\\/g, '/')).toMatch(/remote\/watch\.py$/)
  const start = remote.execCalls.find(isStart)!
  expect(start).toContain('--loop')
  expect(start).toContain("--inbox '/tmp/canness/inbox'")
  expect(start).toContain("--outbox '/tmp/canness/outbox'")
  expect(start).toContain(">> '/tmp/canness/watch.log' 2>&1 &")
  expect(start).toContain("echo $! > '/tmp/canness/watch.pid'")
  expect(remote.execCalls.some(command => command.includes('kill -0'))).toBe(true)
})

test('an existing watch.py is preserved and only the process is started', async () => {
  const remote = freshHost()
  remote.files.set('/tmp/canness/watch.py', Buffer.from('OLD'))
  const result = await ensureRemoteConsumer(remote, base)
  expect(result).toEqual({ ok: true, consumer: 'started' })
  expect(Buffer.from(remote.files.get('/tmp/canness/watch.py')!).toString('utf8')).toBe('OLD')
  expect(remote.puts).toEqual([])
  expect(remote.execCalls.some(isStart)).toBe(true)
})

test('bootstrap: false touches nothing on the remote', async () => {
  const remote = remoteWith(() => ok)
  const result = await ensureRemoteConsumer(remote, { ...base, enabled: false })
  expect(result).toEqual({ ok: true, consumer: 'reused' })
  expect(remote.dirs.size).toBe(0)
  expect(remote.execCalls).toEqual([])
  expect(remote.files.size).toBe(0)
})

test('a bootstrapCommand exit 0 counts as ready and deploys no mock', async () => {
  const remote = remoteWith(command => isPgrep(command) ? fail : ok)
  const result = await ensureRemoteConsumer(remote, { ...base, command: 'touch /tmp/canness/ready' })
  expect(result).toEqual({ ok: true, consumer: 'command' })
  expect(remote.files.size).toBe(0)
  expect(remote.puts).toEqual([])
  expect(remote.execCalls.some(isStart)).toBe(false)
})

test('a failing bootstrapCommand reports its exit code and stderr digest', async () => {
  const remote = remoteWith(command => {
    if (isPgrep(command)) return fail
    if (command === 'sh start.sh') return { code: 127, stdout: '', stderr: 'sh: 1: start.sh: not found\n' }
    return fail
  })
  const result = await ensureRemoteConsumer(remote, { ...base, command: 'sh start.sh' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.reason).toContain('exited 127')
    expect(result.reason).toContain('not found')
  }
  expect(remote.files.size).toBe(0)
})

test('a remote without python fails before starting anything', async () => {
  const remote = remoteWith(command => (isPgrep(command) || isPythonProbe(command) ? fail : ok))
  const result = await ensureRemoteConsumer(remote, base)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain('python')
  expect(remote.execCalls.some(isStart)).toBe(false)
})

test('a consumer that dies right after start fails the bootstrap', async () => {
  let clock = 0
  const remote = remoteWith(command => {
    if (isPgrep(command)) return fail
    if (isPythonProbe(command)) return { code: 0, stdout: '/usr/bin/python3\n', stderr: '' }
    if (isStart(command)) return ok
    return fail
  })
  const result = await ensureRemoteConsumer(remote, {
    ...base,
    timeoutMs: 1000,
    intervalMs: 250,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.reason).toContain('exited immediately')
  expect(clock).toBe(1000)
})

test('shellQuote escapes embedded single quotes and pid probes quote the path', () => {
  expect(shellQuote("/tmp/it's here")).toBe("'/tmp/it'\\''s here'")
  const command = pidAliveCommand('/tmp/canness/watch.pid')
  expect(command).toContain('kill -0')
  expect(command).toContain("cat '/tmp/canness/watch.pid'")
})
