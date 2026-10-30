/**
 * CANNESS browser half: the Settings-panel card for the canness-eval entry.
 * The card registers into `settings.section` while the Host serves the
 * canness-eval namespace, so a deployment without the plugin shows no trace
 * of it. The password control writes through the credentials domain; every
 * other field saves through the shared settings form into the profile patch.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms merge and the settings slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.slots merge (SlotRegistry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { EvalCard } from './EvalCard.tsx'
import { EvalCardController, EVAL_NS } from './eval-card-controller.ts'
import { en, zh, type CannessSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** CANNESS settings card copy. */
    'settings.canness': CannessSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.canness'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** Mount the CANNESS settings card while the Host serves the canness-eval namespace. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canness-client: dictionaries')
  const card = new EvalCardController(ctx, ctx.configForms.get(EVAL_NS))
  ctx.effect(() => () => { card.dispose() }, 'canness-client: form subscription')
  // The credential the card reports is not part of any settings section, so
  // this is the only signal that a password written elsewhere reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref: string) => { card.refreshCredential(ref) }),
    'canness-client: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([EVAL_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'canness',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: () => card.inject(),
  }, EvalCard))), 'canness-client: settings section')
}
