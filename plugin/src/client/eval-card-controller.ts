/**
 * The CANNESS settings card's staged form over the `canness-eval` entry:
 * remote-host fields save through the settings form (path ops into the
 * profile patch), while the SSH password is written through the credentials
 * domain, so its literal never rides a settings response. The auth mode
 * switch is presentational: it only chooses which credential field the card
 * shows, and the Host-side priority (private key first) is unchanged.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Profile entry id the card edits; the Host plugin row id in cordis.patch.yml. */
export const EVAL_NS = 'canness-eval'

/** Credential reference the password control addresses when the section names none. */
const DEFAULT_PASSWORD_REF = 'CANNNESS_SSH_PASSWORD'

/** Form field the credential control stages under. */
const PASSWORD_FIELD = 'password'

/** The canness-eval fields this card edits. */
export interface EvalSettings {
  host?: string
  port?: number
  username?: string
  privateKeyPath?: string
  passwordEnv?: string
  inbox?: string
  outbox?: string
  timeoutSec?: number
  pollIntervalMs?: number
  maxIterations?: number
  maxCompileRetries?: number
  negativeStreakLimit?: number
  convergenceThreshold?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

/** What the CANNESS card renders. */
export interface EvalCardState extends SettingsFormShell {
  host: SettingsFieldState
  port: SettingsFieldState
  username: SettingsFieldState
  privateKeyPath: SettingsFieldState
  inbox: SettingsFieldState
  outbox: SettingsFieldState
  timeoutSec: SettingsFieldState
  pollIntervalMs: SettingsFieldState
  maxIterations: SettingsFieldState
  maxCompileRetries: SettingsFieldState
  negativeStreakLimit: SettingsFieldState
  convergenceThreshold: SettingsFieldState
  /** The staged password draft; blank on every load and never echoed back. */
  password: SettingsFieldState
  /** Whether the credentials domain reports a password for the referenced key. */
  passwordConfigured: boolean
  /** Whether the credentials domain accepts a write; false disables the control. */
  passwordWritable: boolean
  /** Presentational auth mode: true shows the password field, false the key path. */
  usePassword: boolean
}

/** The registration-side face the card's slot entry injects. */
export interface EvalCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as useEvalCard. */
    evalCard: SnapshotStore<EvalCardState>
  }
  /** Switch the credential field the card shows; stages nothing. */
  setUsePassword: (enabled: boolean) => void
}

/** Bridges the canness-eval settings form and the credentials domain onto the card. */
export class EvalCardController {
  private readonly form: SettingsFormModel<EvalSettings>
  private readonly store: SnapshotStore<EvalCardState>
  private readonly unsubscribeScope: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private modeOverride: boolean | undefined

  /**
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the password the section references.
   * @param scope - the shared configuration form for the canness-eval entry.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly scope: SettingsFormScope<EvalSettings>,
  ) {
    this.form = new SettingsFormModel(scope, [
      settingsTextField('host'),
      settingsNumberField('port'),
      settingsTextField('username'),
      settingsTextField('privateKeyPath'),
      settingsTextField('inbox'),
      settingsTextField('outbox'),
      settingsNumberField('timeoutSec'),
      settingsNumberField('pollIntervalMs'),
      settingsNumberField('maxIterations'),
      settingsNumberField('maxCompileRetries'),
      settingsNumberField('negativeStreakLimit'),
      settingsNumberField('convergenceThreshold'),
    ], [{ field: PASSWORD_FIELD, write: text => this.writePassword(text) }])
    this.store = this.form.bind(() => this.projection())
    this.unsubscribeScope = scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  /** The reference the section names, or the default. */
  private ref(): string {
    const declared = this.scope.getSnapshot().value?.passwordEnv
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_PASSWORD_REF
  }

  private async readCredential(): Promise<void> {
    const ref = this.ref()
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== this.ref()) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference stays writable: the Host refuses, not the card.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches;
   * a password written on another surface must refresh the badge.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  private async writePassword(value: string): Promise<boolean> {
    // Refusals surface through the re-read: the Host is the only authority.
    await this.ctx.remote.credentials.set(this.ref(), value)
    await this.readCredential()
    return this.credential.configured
  }

  private projection(): EvalCardState {
    return {
      ...this.form.shell(),
      host: this.form.field('host'),
      port: this.form.field('port'),
      username: this.form.field('username'),
      privateKeyPath: this.form.field('privateKeyPath'),
      inbox: this.form.field('inbox'),
      outbox: this.form.field('outbox'),
      timeoutSec: this.form.field('timeoutSec'),
      pollIntervalMs: this.form.field('pollIntervalMs'),
      maxIterations: this.form.field('maxIterations'),
      maxCompileRetries: this.form.field('maxCompileRetries'),
      negativeStreakLimit: this.form.field('negativeStreakLimit'),
      convergenceThreshold: this.form.field('convergenceThreshold'),
      password: this.form.field(PASSWORD_FIELD),
      passwordConfigured: this.credential.configured,
      passwordWritable: this.credential.writable,
      usePassword: this.modeOverride ?? this.form.field('privateKeyPath').text.trim() === '',
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the auth-mode switch.
   */
  inject(): EvalCardFace {
    const actions = this.form.actions()
    return {
      hooks: { evalCard: this.store },
      ...actions,
      discard: () => {
        this.modeOverride = undefined
        actions.discard()
      },
      setUsePassword: (enabled) => {
        this.modeOverride = enabled
        this.store.set(this.projection())
      },
    }
  }

  /** Release the form and scope subscriptions. */
  dispose(): void {
    this.unsubscribeScope()
    this.form.dispose()
  }
}
