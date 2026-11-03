import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const hasPython = spawnSync('python', ['--version']).status === 0

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the result file')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('watch.py writes a pass result from the manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'canness-watch-'))
  const inbox = join(root, 'inbox', 'gen-01234567')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'manifest.json'), JSON.stringify({
    generationId: 'gen-01234567',
    performanceTargetUs: 150,
  }))
  const outbox = join(root, 'outbox')
  const run = spawnSync('python', [
    'remote/watch.py', '--inbox', join(root, 'inbox'), '--outbox', outbox, '--once',
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' })
  expect(run.status).toBe(0)
  const result = JSON.parse(readFileSync(join(outbox, 'gen-01234567', 'results.json'), 'utf8'))
  expect(result).toMatchObject({
    generationId: 'gen-01234567',
    status: 'pass',
    performance: { kernelTimeUs: 150, targetUs: 150 },
    summary: 'mock pass',
    analysis: {
      source: 'msprof-mock',
      bottleneck: 'memory',
      op: {
        taskDurationUs: 150,
        aicMacRatio: 0.12,
        aicMte2Ratio: 0.71,
        aicScalarRatio: 0.09,
        cubeUtilizationPct: 18.4,
      },
    },
  })
  expect(result.analysis.summary).toContain('Task Duration')
  expect(result.analysis.summary).toContain('aic_mte2_ratio')
  expect(result.analysis.summary).toContain('cube_utilization')
})

test.skipIf(!hasPython)('watch.py --loop keeps scanning until it is killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'canness-watch-loop-'))
  const inbox = join(root, 'inbox')
  mkdirSync(join(inbox, 'gen-loop0001'), { recursive: true })
  writeFileSync(join(inbox, 'gen-loop0001', 'manifest.json'), JSON.stringify({
    generationId: 'gen-loop0001',
    performanceTargetUs: 90,
  }))
  const outbox = join(root, 'outbox')
  const child = spawn('python', [
    'remote/watch.py', '--inbox', inbox, '--outbox', outbox, '--loop', '--interval', '100',
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore', windowsHide: true })
  try {
    const resultPath = join(outbox, 'gen-loop0001', 'results.json')
    await waitFor(() => readFileSafe(resultPath) !== null, 5000)
    expect(JSON.parse(readFileSafe(resultPath)!)).toMatchObject({
      generationId: 'gen-loop0001',
      status: 'pass',
      performance: { kernelTimeUs: 90 },
    })
    // A loop consumer is still running after the first sweep, unlike --once.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill()
  }
})

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
