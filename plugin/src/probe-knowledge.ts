import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { runIntrinsicProbe } from './intrinsic-probe.js'
import { loadKnowledgeEntries, type KnowledgeEntry } from './knowledge-entry.js'

export function probeKnowledgeRoot(workspace: string): string {
  return join(workspace, '.canness', 'probe-knowledge')
}

export function loadProbeKnowledge(workspace: string): KnowledgeEntry[] {
  const root = probeKnowledgeRoot(workspace)
  if (!existsSync(root)) return []
  return loadKnowledgeEntries(root).map(entry => {
    // Older probe files mixed the caller's conclusion into the measured result.
    const legacy = /^probe-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.id)
    return legacy && entry.evidence === 'reproduced' ? { ...entry, evidence: 'reported' } : entry
  })
}

export function parseProbeConclusion(note: { title: string; conclusion: string }) {
  const title = note.title.trim()
  const conclusion = note.conclusion.trim()
  if (!title || title.length > 120 || !conclusion || conclusion.length > 1000) {
    throw new Error('probe record requires a title of at most 120 characters and a conclusion of at most 1000 characters')
  }
  return { title, conclusion }
}

function writeProbeEntry(path: string, header: Omit<KnowledgeEntry, 'body'>, body: string): void {
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, `---\n${JSON.stringify(header, null, 2)}\n---\n${body}\n`, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function recordProbeConclusion(workspace: string, note: { title: string; conclusion: string }, probe: Awaited<ReturnType<typeof runIntrinsicProbe>>): string {
  const id = `probe-${randomUUID()}`
  const comparisonId = `${id}-comparison`
  const operator = probe.operator.trim().slice(0, 120).trimEnd()
  const common = { schema_version: 1, kind: 'troubleshooting', operator } as const
  const comparison: Omit<KnowledgeEntry, 'body'> = {
    ...common, id: comparisonId,
    title: `Probe comparison for ${operator}`.slice(0, 120).trimEnd(), evidence: 'reproduced',
    sources: [
      { ref: probe.resultsPath?.slice(0, 500).trim() || 'remote probe report' },
      { ref: 'probe kernel source', sha256: probe.kernelSha256 },
      { ref: 'probe golden source', sha256: probe.goldenSha256 },
    ],
  }
  const measurement = [
    `Probe result: ${probe.report.status}. Toolchain: ${probe.report.runRecord?.toolchain.slice(0, 250) ?? 'unknown'}.`,
    `Correctness check: ${probe.report.correctness.ok ? 'passed' : 'failed'}.`,
    `Maximum relative error: ${probe.report.correctness.maxRelativeError ?? 'unavailable'}.`,
  ].join('\n')
  const callerNote: Omit<KnowledgeEntry, 'body'> = {
    ...common, id: `${id}-note`, title: note.title, evidence: 'reported',
    sources: [{ ref: 'probe_run caller conclusion' }, { ref: `${comparisonId}.md` }],
  }
  const entries = join(probeKnowledgeRoot(workspace), 'entries')
  mkdirSync(entries, { recursive: true })
  const path = join(entries, `${comparisonId}.md`)
  writeProbeEntry(path, comparison, measurement)
  try {
    writeProbeEntry(join(entries, `${callerNote.id}.md`), callerNote, note.conclusion)
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  return path
}
