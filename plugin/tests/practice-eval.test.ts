import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import * as evaluator from '../src/eval.ts'
import { emptyState } from '../src/policy.ts'
import { loadState, saveState } from '../src/state-file.ts'
import { MemoryRemote } from '../src/remote.ts'

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-practice-'))
  const path = join(workspace, '.canness/state.json')
  const generationId = 'gen-practice'
  const pkg = join(workspace, 'packages', generationId)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'manifest.json'), '{}')
  writeFileSync(join(workspace, 'key'), 'TEST KEY')
  const tools: any[] = []
  const vol = (value: unknown) => ({ get: () => value })
  const cfg: any = { workspace, host: vol('test'), port: vol(22), username: vol('test'), privateKeyPath: vol(join(workspace, 'key')),
    passwordEnv: vol('PW'), inbox: vol('/in'), outbox: vol('/out'), timeoutSec: vol(1), pollIntervalMs: vol(1),
    maxIterations: vol(10), maxCompileRetries: vol(3), negativeStreakLimit: vol(3), convergenceThreshold: vol(0.05) }
  const remote = new MemoryRemote()
  remote.execHandler = command => {
    const id = command.match(/--generation '([^']+)'/)?.[1]
    const outbox = command.match(/--outbox '([^']+)'/)?.[1]
    if (id && outbox) remote.files.set(`${outbox}/${id}/results.json`, Buffer.from(JSON.stringify({
      generationId, status: command.includes('--compile-only') ? 'pass' : 'perf_fail',
      compile: { ok: true, log: '' }, correctness: { ok: !command.includes('--compile-only'), maxRelativeError: 0 },
      performance: { kernelTimeUs: command.includes('--compile-only') ? null : 100, targetUs: 10 }, analysis: null, summary: 'fixture result' })))
    return { code: 0, stdout: '', stderr: '' }
  }
  evaluator.apply({ tools: { register: (t: unknown) => tools.push(t) }, get: () => undefined } as never, cfg, async () => remote)
  const tool = tools.find(t => t.name === 'run_evaluation')
  saveState(path, { ...emptyState(), generationId, bestKernelTimeUs: 90, negativeStreak: 3, pendingStage: 'run_evaluation' })
  return { path, pkg, tool, remote, preflight: tools.find(t => t.name === 'preflight_evaluation') }
}
test('policy blocks report a policy reason without suggesting transport recovery', async () => {
  const { tool, path } = fixture()
  expect(await tool.execute({})).toMatchObject({ blockedBy: 'policy', stopReason: 'negativeStreak', pendingStage: null })
  expect(loadState(path).lastBlocked).toMatchObject({ reason: 'negativeStreak', blockedBy: 'policy' })
  expect((await tool.execute({})).budget).toMatchObject({ maxIterations: 10, validIterations: 0 })
})
test('a failing requested local kernel check stops before SSH and spends no iteration', async () => {
  const { path, tool, remote } = fixture()
  const result = await tool.execute({ kernel_dtypes: ['not-a-dtype'] })
  expect(result).toMatchObject({ status: 'error', localKernel: { targetValidated: false } })
  expect(remote.execCalls).toEqual([])
  expect(loadState(path).validIterations).toBe(0)
})
test('force crosses a heuristic stop once and never triggers automatic continuation', async () => {
  const { path, tool } = fixture()
  expect(await tool.execute({ force: true })).toMatchObject({ status: 'perf_fail' })
  expect(loadState(path)).toMatchObject({ forcedRunsAfterStop: 1, pendingSteer: false })
  expect(await tool.execute({ force: true })).toMatchObject({ blockedBy: 'policy', pendingStage: null })
})
test('compile-only runs despite a policy stop without overwriting counters or measurement state', async () => {
  const { path, tool, remote } = fixture()
  const before = loadState(path)
  const result = await tool.execute({ compile_only: true })
  expect(result).toMatchObject({ compileOnly: true, compile: { ok: true }, correctness: { ok: false }, pendingStage: null })
  expect(result.resultsPath).toMatch(/gen-practice-compile-/)
  expect(loadState(path)).toEqual(before)
  expect(remote.execCalls.some(command => command.includes('--compile-only'))).toBe(true)
})

test('a stale state hash neither authorizes nor blocks a real evaluation (CAN-104)', async () => {
  const { path, tool } = fixture()
  saveState(path, { ...loadState(path), packageHash: 'stale-state' })
  // The manifest carries no hash; the stale state must not reject the run.
  const result = await tool.execute({ force: true })
  expect(result.status).toBe('perf_fail')
})

test('compile-only ignores a stale manifest hash instead of blocking the diagnostic (CAN-104)', async () => {
  const { tool, pkg } = fixture()
  writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ packageHash: 'stale-manifest' }))
  const result = await tool.execute({ compile_only: true })
  expect(result).toMatchObject({ compileOnly: true, compile: { ok: true } })
})

test('a changed manifest names manifest, state, and actual hashes (CAN-104)', async () => {
  const { path, tool, pkg } = fixture()
  saveState(path, { ...loadState(path), packageHash: 'state-hash' })
  writeFileSync(join(pkg, 'manifest.json'), JSON.stringify({ packageHash: 'manifest-hash' }))
  await expect(tool.execute({ force: true }))
    .rejects.toThrow(/manifest=manifest-hash, state=state-hash, actual=[0-9a-f]+/)
})
