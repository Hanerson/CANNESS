/** The sentence under the connectivity button. */

import type { CannessSettingsLocaleKey } from './locales.ts'

type Translate = (key: CannessSettingsLocaleKey) => string

/**
 * The status line for one finished check.
 * An unavailable check keeps its remote or command reason in the same sentence.
 * @param t - the card's locale reader.
 * @param reason - probe reason, empty when the check succeeded.
 * @param detail - extra text from the probe, or a stable token such as `command-missing`.
 * @returns the sentence to show.
 */
export function probeMessage(t: Translate, reason: string, detail: string): string {
  if (reason === 'empty-host') return t('probeEmptyHost')
  if (reason === 'invalid-port') return t('probeInvalidPort')
  if (reason === 'no-session') return t('probeNoSession')
  if (reason === 'unavailable') return unavailableMessage(t, detail)
  if (detail === 'timeout') return t('probeTimeout')
  if (detail.length > 0) return `${t('probeUnreachable')} (${detail})`
  return t('probeUnreachable')
}

/** Turn an unavailable detail token into the sentence the card shows. */
function unavailableMessage(t: Translate, detail: string): string {
  if (detail === 'command-missing') return t('probeCommandMissing')
  if (detail === 'result-missing') return t('probeResultMissing')
  const listed = detail.startsWith('list:') ? detail.slice('list:'.length) : undefined
  if (listed !== undefined) return `${t('probeListFailed')} (${listed})`
  const executed = detail.startsWith('execute:') ? detail.slice('execute:'.length) : undefined
  if (executed !== undefined) return `${t('probeExecuteFailed')} (${executed})`
  if (detail.length > 0) return `${t('probeUnavailable')}(${detail})`
  return t('probeUnavailable')
}
