import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

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
