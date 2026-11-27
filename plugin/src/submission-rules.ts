/**
 * Submission rules that the CANNBENCH scorer enforces but the local evaluation
 * loop cannot observe.
 *
 * The rules come from the knowledge base entries cited in each finding, so a
 * failing check can be traced back to the scorer code it mirrors.
 */

export type FindingSeverity = 'error' | 'warning'

export interface SubmissionFinding {
  rule: string
  severity: FindingSeverity
  path: string
  message: string
}

export interface SubmissionRulesReport {
  ok: boolean
  findings: SubmissionFinding[]
}

/** Text view of an exported file, or null when it is not UTF-8 decodable. */
function decode(content: Buffer | string): string | null {
  if (typeof content === 'string') return content
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    return null
  }
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

/**
 * The scorer treats any `aclrtMemcpy*` row in api_statistic.csv with
 * Count > 5 as a CPU fallback and zeroes the whole operator.
 * See knowledge_base/entries/cannbench-aclrtmemcpy-budget-zeroes-score.md.
 */
function checkLauncherCopyBudget(path: string, source: string, findings: SubmissionFinding[]): void {
  const calls = [...source.matchAll(/aclrtMemcpy(?:Async)?\s*\(/g)].map(match => match.index ?? 0)
  if (calls.length === 0) return
  if (calls.length > 1) {
    findings.push({
      rule: 'aclrtmemcpy-budget', severity: 'error', path,
      message: `${calls.length} host copy calls: api_statistic.csv counts them per API name and the scorer `
        + 'zeroes the operator above five (cannbench-aclrtmemcpy-budget-zeroes-score)',
    })
    return
  }
  const copy = calls[0]!
  const guard = source.lastIndexOf('CannessTilingChanged', copy)
  if (guard < 0) {
    findings.push({
      rule: 'aclrtmemcpy-budget', severity: 'error', path,
      message: `host copy at line ${lineOf(source, copy)} runs on every launch; it must sit behind the `
        + 'attribute cache so a benchmark loop uploads the tiling block once',
    })
    return
  }
  const drain = source.lastIndexOf('aclrtSynchronizeDevice', copy)
  if (drain < guard) {
    findings.push({
      rule: 'aclrtmemcpy-ordering', severity: 'error', path,
      message: `host copy at line ${lineOf(source, copy)} is not preceded by aclrtSynchronizeDevice; `
        + 'a blocking host-to-device copy is only ordered against the default stream',
    })
  }
}

/** The tiling block must outlive the asynchronous launch. */
function checkTilingLifetime(path: string, source: string, findings: SubmissionFinding[]): void {
  if (/_tiling_buffer\s*\(/.test(source)) return
  const call = /canness_launch\s*\(/.exec(source)
  if (call === null) return
  const before = source.slice(0, call.index)
  const perCall = /tiling\s*=\s*_torch\.empty\s*\(/.test(before.slice(before.lastIndexOf('def ')))
  if (perCall) {
    findings.push({
      rule: 'tiling-lifetime', severity: 'error', path,
      message: 'the wrapper allocates the tiling block inside the callable; the kernel reads it after the '
        + 'call returns, so it must be cached per device',
    })
  }
}

/** Attribute rows that no signature parameter or fixed attribute can produce. */
function checkSupportRows(path: string, source: string, findings: SubmissionFinding[]): void {
  if (!source.includes('UnsupportedConfiguration')) return
  if (!/support\.configurations|"configurations"/.test(source)) {
    findings.push({
      rule: 'support-rows', severity: 'warning', path,
      message: 'the wrapper raises UnsupportedConfiguration but no configurations are visible to a reader',
    })
  }
}

export function lintSubmissionSources(files: Record<string, Buffer | string>): SubmissionRulesReport {
  const findings: SubmissionFinding[] = []
  for (const [path, content] of Object.entries(files)) {
    const text = decode(content)
    if (text === null) {
      findings.push({
        rule: 'utf8', severity: 'error', path,
        message: 'file is not valid UTF-8; the validator parses Python sources as UTF-8 and will reject it',
      })
      continue
    }
    if (path === 'csrc/launch.cpp') checkLauncherCopyBudget(path, text, findings)
    if (path === 'cann_bench/__init__.py') {
      checkTilingLifetime(path, text, findings)
      checkSupportRows(path, text, findings)
    }
  }
  return { ok: !findings.some(finding => finding.severity === 'error'), findings }
}

export function describeFindings(findings: SubmissionFinding[]): string {
  return findings.map(finding => `[${finding.severity}] ${finding.rule} (${finding.path}): ${finding.message}`).join('; ')
}
