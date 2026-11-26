import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { runIntrinsicProbe } from './intrinsic-probe.js'

export function probeKnowledgeRoot(workspace: string): string {
  return join(workspace, '.canness', 'probe-knowledge')
}

export function parseProbeConclusion(note: { title: string; conclusion: string }) {
  const title = note.title.trim()
  const conclusion = note.conclusion.trim()
  if (!title || title.length > 120 || !conclusion || conclusion.length > 1000) {
    throw new Error('probe record requires a title of at most 120 characters and a conclusion of at most 1000 characters')
  }
  return { title, conclusion }
}

export function recordProbeConclusion(workspace: string, note: { title: string; conclusion: string }, probe: Awaited<ReturnType<typeof runIntrinsicProbe>>): string {
  const id = `probe-${randomUUID()}`
  const header = {
    schema_version: 1, id, title: note.title, kind: 'troubleshooting', evidence: 'reproduced',
    operator: probe.operator.trim().slice(0, 120).trimEnd(),
    sources: [
      { ref: probe.resultsPath?.slice(0, 500).trim() || 'remote probe report' },
      { ref: 'probe kernel source', sha256: probe.kernelSha256 },
      { ref: 'probe golden source', sha256: probe.goldenSha256 },
    ],
  }
  const body = [
    note.conclusion,
    '',
    `Probe result: ${probe.report.status}. Toolchain: ${probe.report.runRecord?.toolchain.slice(0, 250) ?? 'unknown'}.`,
    `Maximum relative error: ${probe.report.correctness.maxRelativeError ?? 'unavailable'}.`,
  ].join('\n')
  const entries = join(probeKnowledgeRoot(workspace), 'entries')
  mkdirSync(entries, { recursive: true })
  const path = join(entries, `${id}.md`)
  writeFileSync(path, `---\n${JSON.stringify(header, null, 2)}\n---\n${body}\n`, { flag: 'wx' })
  return path
}
