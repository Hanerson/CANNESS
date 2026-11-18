import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { MemoryRemote } from '../src/remote.ts'
import { validateSubmission } from '../src/submission-validation.ts'

test('uploads an isolated diagnostic runner and script without touching evaluation state', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'submission-validation-'))
  writeFileSync(join(sourceDir, 'provenance.json'), '{"files":{}}')
  const remote = new MemoryRemote()
  remote.execHandler = () => ({ code: 0, stdout: 'CANNESS_SUBMISSION_REPORT {"status":"installed","correctness":"unverified"}\n', stderr: '' })
  const report = await validateSubmission(remote, { sourceDir, remoteRoot: '/diagnostics', setEnv: '/opt/CANN/set_env.sh', testScript: 'print("CANNESS_VALIDATION {\\"ok\\":true}")', timeoutSec: 30 })
  expect(report).toMatchObject({ status: 'installed', correctness: 'unverified' })
  expect(remote.execCalls[0]).toContain('--timeout-sec 30')
  expect(remote.execCalls[0]).toContain('--set-env')
  expect([...remote.files.keys()].some(path => path.endsWith('/test.py'))).toBe(true)
  expect([...remote.files.keys()].some(path => path.endsWith('/validate_submission.py'))).toBe(true)
})
test('missing or failed runner reports never imply correctness', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'submission-validation-'))
  const remote = new MemoryRemote()
  remote.execHandler = () => ({ code: 124, stdout: '', stderr: 'timeout' })
  expect(await validateSubmission(remote, { sourceDir, remoteRoot: '/diagnostics' })).toMatchObject({ status: 'failed', correctness: 'unverified' })
})

test('tampered files are rejected before upload or execution', async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), 'submission-validation-'))
  writeFileSync(join(sourceDir, 'provenance.json'), '{"files":{"build.sh":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}')
  writeFileSync(join(sourceDir, 'build.sh'), 'echo changed')
  const remote = new MemoryRemote()
  expect(await validateSubmission(remote, { sourceDir, remoteRoot: '/diagnostics' })).toMatchObject({ status: 'failed', correctness: 'unverified', reason: 'submission provenance mismatch: build.sh' })
  expect(remote.execCalls).toHaveLength(0)
  expect(remote.files.size).toBe(0)
})
