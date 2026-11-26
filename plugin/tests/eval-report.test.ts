import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseAnalysis } from '../src/analysis.ts'
import { parseReport } from '../src/report.ts'

/** Built by concatenation so the anti-regression grep does not hit this test. */
const MOCK_SOURCE = ['msprof', 'mock'].join('-')
const NO_MSPROF_PHRASE = ['Does', 'not', 'call', 'msprof'].join(' ')

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules' && name !== '.git') walk(full)
        continue
      }
      if (/\.(ts|tsx|mjs|js|py)$/.test(name)) out.push(full)
    }
  }
  walk(root)
  return out
}

test('no source or remote script still produces a mock analysis', () => {
  const plugin = fileURLToPath(new URL('..', import.meta.url))
  const offenders: string[] = []
  for (const file of [...sourceFiles(join(plugin, 'src')), ...sourceFiles(join(plugin, 'remote'))]) {
    const body = readFileSync(file, 'utf8')
    if (body.includes(MOCK_SOURCE) || body.includes(NO_MSPROF_PHRASE)) offenders.push(file)
    // The manifest target must not be the measured value on one line.
    if (/kernelTimeUs\s*[:=][^\n]*performanceTargetUs/.test(body)) offenders.push(file)
  }
  expect(offenders).toEqual([])
})

test('parseAnalysis accepts only the real msprof source', () => {
  const real = parseAnalysis({ source: 'msprof', bottleneck: 'memory', summary: 'csv', op: null })
  expect(real).toMatchObject({ source: 'msprof', bottleneck: 'memory' })
  expect(parseAnalysis({ source: MOCK_SOURCE, bottleneck: 'memory', summary: 'x', op: null })).toBeNull()
  expect(parseAnalysis({ source: 'nope', bottleneck: 'memory', summary: 'x', op: null })).toBeNull()
})

test('parseAnalysis retains the self-reported kernel budget and tolerates omitted evidence', () => {
  const analysis = { source: 'msprof', bottleneck: 'scalar', summary: 'csv', op: null }
  const kernelBudget = {
    source: 'correctness-stdout',
    elementBasis: 'output elements',
    blocks: [{ blockIndex: 0, level2Calls: 2, elements: 8, callElements: 16 }],
    level2Calls: 2, elements: 8, callElements: 16,
    perElementCalls: 0.25, averageElementsPerCall: 8,
  }
  expect(parseAnalysis({ ...analysis, kernelBudget })?.kernelBudget).toEqual(kernelBudget)
  expect(parseAnalysis(analysis)?.kernelBudget).toBeUndefined()
  expect(parseAnalysis({ ...analysis, kernelBudget: { ...kernelBudget, level2Calls: true } })?.kernelBudget)
    .toBeUndefined()
})

test('parseReport keeps a valid runRecord and drops an incomplete one', () => {
  const parsed = parseReport({
    generationId: 'gen-1',
    status: 'pass',
    performance: { kernelTimeUs: 30.9, targetUs: 40 },
    runRecord: {
      timestamp: '2026-11-05T09:00:00+0800',
      host: 'npu-host',
      params: { blockDim: 16, tileSize: 1024 },
      toolchain: 'CANN 9.0.0',
      durationMs: 1234,
    },
  })
  expect(parsed.runRecord).toEqual({
    timestamp: '2026-11-05T09:00:00+0800',
    host: 'npu-host',
    params: { blockDim: 16, tileSize: 1024 },
    toolchain: 'CANN 9.0.0',
    durationMs: 1234,
  })
  const missing = parseReport({ status: 'pass', runRecord: { host: 'npu-host' } })
  expect(missing.runRecord).toBeUndefined()
})

test('a report without runRecord stays valid (older results)', () => {
  const parsed = parseReport({ generationId: 'gen-1', status: 'pass', summary: 'ok' })
  expect(parsed.status).toBe('pass')
  expect(parsed.runRecord).toBeUndefined()
})
