import { expect, test } from 'vitest'
import { remoteFromShell } from '../src/ssh2-transport.ts'

test('bounded remote reads pass containment roots to Python and decode bytes', async () => {
  const commands: string[] = []
  const remote = remoteFromShell({ exec: async command => {
    commands.push(command)
    return { code: 0, stdout: Buffer.from('header').toString('base64'), stderr: '' }
  } }, () => {})
  const bytes = await remote.readFileWithin!('/opt/Ascend/include/a.h', ['/opt/Ascend'], 1024)
  expect(Buffer.from(bytes!).toString()).toBe('header')
  expect(commands[0]).toContain('python')
  expect(commands[0]).toContain("'/opt/Ascend/include/a.h'")
  expect(commands[0]).toContain('1024')
})
test('resolved path rejection and oversized files surface instead of returning unconfined content', async () => {
  const remote = remoteFromShell({ exec: async () => ({ code: 45, stdout: '', stderr: 'resolved remote path is outside allowed roots' }) }, () => {})
  await expect(remote.readFileWithin!('/allowed/link', ['/allowed'], 1024)).rejects.toThrow('outside allowed roots')
})
