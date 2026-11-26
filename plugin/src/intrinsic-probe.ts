import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEvaluation, type RunInput } from './eval-run.js'
import { buildTestPackage, writeOperator } from './package-files.js'
import { emptyState } from './policy.js'
import { sha256 } from './provenance.js'
import { parseSpec } from './spec.js'

type ProbeRemote = Pick<RunInput, 'files' | 'inbox' | 'outbox' | 'timeoutMs' | 'intervalMs' | 'setEnv' | 'device' | 'deviceLock'>

export async function runIntrinsicProbe(remote: ProbeRemote, input: { kernel: string; golden: string; spec: unknown }) {
  if (!input.kernel.trim() || !input.golden.trim()) throw new Error('probe requires nonempty kernel and golden source')
  if (input.spec === null || typeof input.spec !== 'object' || Array.isArray(input.spec)) {
    throw new Error('probe requires a spec or an active generation')
  }
  const spec = parseSpec({ ...input.spec, performance_target: { metric: 'kernel_time', target_us: 1 } })
  const generationId = `gen-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const isolated = mkdtempSync(join(tmpdir(), 'canness-intrinsic-'))
  try {
    writeOperator(isolated, generationId, { kernel: input.kernel, host: '', api: '', plugin: '' })
    writeFileSync(join(isolated, 'operators', generationId, 'golden.h'), input.golden)
    const localPackageDir = buildTestPackage(isolated, generationId, spec)
    const { report, resultsPath } = await runEvaluation({
      ...remote, localPackageDir, generationId, accuracyOnly: true,
      state: emptyState(),
      config: { maxIterations: 1, maxCompileRetries: 1, negativeStreakLimit: 1, convergenceThreshold: 0 },
    })
    return {
      report,
      resultsPath: resultsPath ?? null,
      operator: spec.operator_name,
      kernelSha256: sha256(input.kernel),
      goldenSha256: sha256(input.golden),
    }
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
}
