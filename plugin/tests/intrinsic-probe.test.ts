import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { apply } from '../src/eval.ts'
import { apply as registerKnowledge } from '../src/knowledge.ts'
import { MemoryRemote } from '../src/remote.ts'
import { emptyState } from '../src/policy.ts'
import { sha256 } from '../src/provenance.ts'
import { statePath } from '../src/workspace.ts'
import { saveState } from '../src/state-file.ts'

test('probe_run sends a signed temporary kernel and golden without changing the active task', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-probe-test-'))
  try {
    const livePath = statePath(workspace)
    saveState(livePath, { ...emptyState(), generationId: 'gen-11111111', validIterations: 10 })
    const before = readFileSync(livePath)
    const key = join(workspace, 'id_key')
    writeFileSync(key, 'fixture key')
    const kernel = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR out, GM_ADDR tiling) {}'
    const golden = '/* fixture golden */'
    const remote = new MemoryRemote()
    let passes = true
    remote.execHandler = command => {
      const generation = /--generation '([^']+)'/.exec(command)![1]
      const inbox = /--inbox '([^']+)'/.exec(command)![1]
      const outbox = /--outbox '([^']+)'/.exec(command)![1]
      expect(generation).not.toBe('gen-11111111')
      expect(command).toContain('--accuracy-only')
      expect(command).not.toContain('--compile-only')
      expect(command).toContain("--device '3'")
      expect(command).toContain("--lock '/tmp/test.lock'")
      expect(Buffer.from(remote.files.get(`${inbox}/${generation}/golden.h`)!).toString()).toBe(golden)
      expect(Buffer.from(remote.files.get(`${inbox}/${generation}/op_kernel/kernel.cpp`)!).toString()).toBe(kernel)
      remote.files.set(`${outbox}/${generation}/results.json`, Buffer.from(JSON.stringify({
        generationId: generation, status: passes ? 'pass' : 'accuracy_fail', summary: 'probe correctness comparison',
        compile: { ok: true, log: '' }, correctness: { ok: passes, maxRelativeError: passes ? 0 : 0.5 },
        performance: { kernelTimeUs: null, targetUs: null },
      })))
      return { code: 0, stdout: '', stderr: '' }
    }
    const vol = <T,>(value: T) => ({ get: () => value })
    const tools: { name: string; execute: (params: unknown) => Promise<unknown> }[] = []
    apply({ tools: { register: (tool: typeof tools[number]) => tools.push(tool) }, get: () => undefined } as never, {
      workspace, host: vol('npu'), port: vol(22), username: vol('npu'), privateKeyPath: vol(key),
      hostFingerprint: vol('SHA256:' + 'A'.repeat(43)),
      passwordEnv: vol(''), inbox: vol('/in'), outbox: vol('/out'), setEnv: vol(''),
      timeoutSec: vol(1), pollIntervalMs: vol(1), device: vol('3'), deviceLock: vol('/tmp/test.lock'),
    } as never, async () => remote, undefined, { matches: () => false, health: async () => 'none', renew: async () => false })
    const probe = tools.find(tool => tool.name === 'probe_run')
    expect(probe).toBeDefined()
    const input = {
      kernel, golden, record: { title: 'Strided DataCopy probe', conclusion: 'The sample copied a strided tile.' },
      spec: {
        operator_name: 'DataCopy', operator_type: 'probe',
        input_specs: [{ name: 'x', shape: ['16'], dtype: 'float32' }],
        output_specs: [{ name: 'out', shape: ['16'], dtype: 'float32' }],
        target_platform: { chip: 'Ascend910B2' },
      },
    }
    const result = await probe!.execute(input)
    expect(result).toMatchObject({
      report: { status: 'pass', correctness: { ok: true }, performance: { kernelTimeUs: null } },
      kernelSha256: sha256(kernel), goldenSha256: sha256(golden),
    })
    expect(readFileSync(livePath)).toEqual(before)
    const kbRoot = fileURLToPath(new URL('../knowledge_base/', import.meta.url))
    registerKnowledge({ tools: { register: (tool: typeof tools[number]) => tools.push(tool) } } as never, { kbRoot, workspace })
    const search = tools.find(tool => tool.name === 'kb_search')!
    const query = { query: 'strided DataCopy probe', operator_name: 'DataCopy' }
    const normal = await search.execute(query)
    expect(JSON.stringify(normal)).not.toContain('The sample copied a strided tile.')
    const withProbes = await search.execute({ ...query, include_probes: true })
    expect(withProbes).toMatchObject({ hits: expect.arrayContaining([
      expect.objectContaining({
        title: 'Strided DataCopy probe', evidence: 'reported',
        body: expect.stringContaining('The sample copied a strided tile.'),
      }),
      expect.objectContaining({
        evidence: 'reproduced', body: expect.stringContaining('Maximum relative error: 0'),
        sources: expect.arrayContaining([{ ref: 'probe kernel source', sha256: sha256(kernel) }]),
      }),
    ]) })
    const { hits } = withProbes as { hits: { evidence: string; body: string; title: string }[] }
    const measurement = hits.find(hit => hit.evidence === 'reproduced')
    expect(measurement?.body).not.toContain('The sample copied a strided tile.')
    expect(measurement?.title).not.toBe('Strided DataCopy probe')

    passes = false
    const conclusion = 'canx229nonrecordmarker'
    const failed = await probe!.execute({ ...input, record: { title: 'Unverified probe', conclusion } })
    expect(failed).toMatchObject({ report: { status: 'accuracy_fail', correctness: { ok: false } }, knowledgePath: null })
    await expect(search.execute({ query: conclusion, include_probes: true })).resolves.toMatchObject({ hits: [] })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
