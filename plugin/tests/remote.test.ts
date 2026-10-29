import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { MemoryRemote, waitForRemoteFile } from '../src/remote.ts'

test('uploadDir then readFile round-trips bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'canness-'))
  writeFileSync(join(dir, 'manifest.json'), '{"a":1}')
  const remote = new MemoryRemote()
  await remote.uploadDir(dir, '/inbox/gen-1')
  const body = await remote.readFile('/inbox/gen-1/manifest.json')
  expect(JSON.parse(Buffer.from(body!).toString())).toEqual({ a: 1 })
  expect(await remote.readFile('/inbox/gen-1/missing.json')).toBeNull()
})

test('removeFile drops a stored file and a missing path resolves', async () => {
  const remote = new MemoryRemote()
  remote.files.set('/out/gen-1/results.json', Buffer.from('old'))
  await remote.removeFile('/out/gen-1/results.json')
  await remote.removeFile('/out/gen-1/results.json')
  expect(await remote.readFile('/out/gen-1/results.json')).toBeNull()
  await remote.close()
})

test('waitForRemoteFile returns bytes that appear on a later read', async () => {
  const remote = new MemoryRemote()
  remote.appearOnRead('/out/gen-1/results.json', Buffer.from('{"ok":true}'), 2)
  let now = 0
  const body = await waitForRemoteFile(remote, '/out/gen-1/results.json', {
    timeoutMs: 10_000,
    intervalMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms },
  })
  expect(Buffer.from(body).toString()).toBe('{"ok":true}')
  expect(remote.reads).toBe(2)
})

test('waitForRemoteFile throws timeout without sleeping for real', async () => {
  const remote = new MemoryRemote()
  let now = 0
  await expect(waitForRemoteFile(remote, '/out/missing', {
    timeoutMs: 4000,
    intervalMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms },
  })).rejects.toThrow('timeout')
})
