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
import type { ProbeOutcome, ProbeReason } from '../probe-contract.ts'
import type { CannlabEvent, CannlabResult, CannlabStatus, CannlabTarget } from '../cannlab/types.ts'

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

/** Ask the host whether a draft host and port accept a TCP connection. */
export type ProbeFn = (host: string, port: number) => Promise<ProbeOutcome>

/** What the reachability button last did. */
export type ProbeStatus = 'idle' | 'running' | 'ok' | 'error'

/** One line of the CANNLab connect log. */
export interface CannlabLine {
  level: 'info' | 'warn' | 'error' | 'done'
  /** The Host's own sentence; kept verbatim so debugging never depends on the card. */
  text: string
  /** Machine detail: a path, a port, an HTTP status. */
  detail: string
  /** Epoch milliseconds of the line. */
  at: number
}

/** What the CANNLab connect action last did. */
export type CannlabPhase = 'idle' | 'running' | 'ok' | 'error'

/** Everything the CANNLab panel renders. */
export interface CannlabPanelState {
  status: CannlabPhase
  /** Log lines in arrival order, oldest first. */
  lines: readonly CannlabLine[]
  /** A refresh token is stored, so a reconnect needs no browser. */
  signedIn: boolean
  /** GitCode account name, when known. */
  account: string
  /** `user@host:port` of the tunnel this card last staged. */
  applied: string
  /** Why the last attempt stopped. */
  reason: string
  /** Authorization URL to offer when no browser could be launched. */
  authorizeUrl: string
  /**
   * Environment to connect to, by name or id. Empty picks the only running
   * one, which is the common case; an account may hold one CPU and one NPU
   * environment at once, so the choice has to be expressible.
   */
  instance: string
}

/** The action set the CANNLab panel calls. */
export interface CannlabActions {
  /** Sign in, find a running environment, open the tunnel, and stage the result. */
  connectCannlab: () => void
  /** Close the live tunnel on the Host. */
  disconnectCannlab: () => void
  /** Re-read the Host's tunnel status. */
  refreshCannlab: () => void
  /** Name the environment to connect to, or clear it to accept the only running one. */
  setCannlabInstance: (text: string) => void
}

/** The Host-side connect operations the card calls. */
export interface CannlabApi {
  /** Run the flow, reporting each stage; resolves with the staged target or a reason. */
  connect(instance: string, onEvent: (event: CannlabEvent) => void, signal: AbortSignal): Promise<CannlabResult>
  /** Read the Host's current tunnel state, or null when the Host half is absent. */
  status(): Promise<CannlabStatus | null>
  /** Close the live tunnel. */
  disconnect(): Promise<boolean>
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
  /** Saved host, user, port, and credential are enough for a later evaluation. */
  ready: boolean
  /** `user@host:port` from the saved section, empty until the section is ready. */
  readyTarget: string
  /** Which saved credential the readiness line names. */
  readyAuth: 'password' | 'key'
  /** Latest reachability check. */
  probeStatus: ProbeStatus
  /** Why the latest check failed; empty when it has not failed. */
  probeReason: ProbeReason | ''
  /** Dial error text, such as `timeout`, when the port did not connect. */
  probeDetail: string
  /** Whether the last landed save should show its short confirmation. */
  showSaved: boolean
  /** Increments on each landed save so the confirmation can show again. */
  savedToken: number
  /** The CANNLab connect panel. */
  cannlab: CannlabPanelState
}

/** The registration-side face the card's slot entry injects. */
export interface EvalCardFace extends SettingsFormActions, CannlabActions {
  hooks: {
    /** Card snapshot bound by the renderer as useEvalCard. */
    evalCard: SnapshotStore<EvalCardState>
  }
  /** Switch the credential field the card shows; stages nothing. */
  setUsePassword: (enabled: boolean) => void
  /** Try a TCP connect to the draft host and port. */
  testConnection: () => void
  /** Hide the save confirmation after it has been shown. */
  dismissSaved: () => void
}

/** Bridges the canness-eval settings form and the credentials domain onto the card. */
export class EvalCardController {
  private readonly form: SettingsFormModel<EvalSettings>
  private readonly store: SnapshotStore<EvalCardState>
  private readonly unsubscribeScope: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private modeOverride: boolean | undefined
  private probeStatus: ProbeStatus = 'idle'
  private probeReason: ProbeReason | '' = ''
  private probeDetail = ''
  private probeSeq = 0
  private showSaved = false
  private savedToken = 0
  private cannlab: CannlabPanelState = {
    status: 'idle',
    lines: [],
    signedIn: false,
    account: '',
    applied: '',
    reason: '',
    authorizeUrl: '',
    instance: '',
  }
  private cannlabAbort: AbortController | undefined

  /**
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the password the section references.
   * @param scope - the shared configuration form for the canness-eval entry.
   * @param probe - reachability check the Host answers.
   * @param cannlab - connect-flow calls the Host answers.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly scope: SettingsFormScope<EvalSettings>,
    private readonly probe: ProbeFn = async () => ({ ok: false, reason: 'unavailable' }),
    private readonly cannlabApi: CannlabApi = {
      connect: async () => ({ ok: false, reason: 'the connect route is unavailable' }),
      status: async () => null,
      disconnect: async () => false,
    },
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
      usePassword: this.usePasswordNow(),
      ...this.readiness(),
      probeStatus: this.probeStatus,
      probeReason: this.probeReason,
      probeDetail: this.probeDetail,
      showSaved: this.showSaved,
      savedToken: this.savedToken,
      cannlab: this.cannlab,
    }
  }

  /** The switch wins over the saved key path until discard. */
  private usePasswordNow(): boolean {
    return this.modeOverride ?? this.form.field('privateKeyPath').text.trim() === ''
  }

  /** Readiness follows the saved section, not an unsaved draft. */
  private readiness(): Pick<EvalCardState, 'ready' | 'readyTarget' | 'readyAuth'> {
    const value = this.scope.getSnapshot().value
    const host = value?.host?.trim() ?? ''
    const username = value?.username?.trim() ?? ''
    const port = value?.port
    const key = value?.privateKeyPath?.trim() ?? ''
    const portOk = typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
    const readyAuth = key.length === 0 ? 'password' : 'key'
    const authed = readyAuth === 'key' || this.credential.configured
    const ready = host.length > 0 && username.length > 0 && portOk && authed
    return {
      ready,
      readyTarget: ready ? `${username}@${host}:${port}` : '',
      readyAuth,
    }
  }

  /** Draft port, or undefined when it is not an integer in range. */
  private draftPort(): number | undefined {
    const text = this.form.field('port').text.trim()
    if (!/^\d+$/.test(text)) return undefined
    const port = Number(text)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return port
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, the auth-mode switch, and the reachability check.
   */
  inject(): EvalCardFace {
    const actions = this.form.actions()
    return {
      hooks: { evalCard: this.store },
      ...actions,
      discard: () => {
        this.modeOverride = undefined
        this.showSaved = false
        actions.discard()
      },
      save: () => { this.commit() },
      setUsePassword: (enabled) => {
        this.modeOverride = enabled
        this.store.set(this.projection())
      },
      dismissSaved: () => {
        if (!this.showSaved) return
        this.showSaved = false
        this.store.set(this.projection())
      },
      testConnection: () => {
        if (this.probeStatus === 'running') return
        const host = this.form.field('host').text.trim()
        const port = this.draftPort()
        if (host.length === 0) {
          this.applyProbe({ ok: false, reason: 'empty-host' })
          return
        }
        if (port === undefined) {
          this.applyProbe({ ok: false, reason: 'invalid-port' })
          return
        }
        const seq = this.probeSeq + 1
        this.probeSeq = seq
        this.probeStatus = 'running'
        this.probeReason = ''
        this.probeDetail = ''
        this.store.set(this.projection())
        void this.probe(host, port).then(result => {
          if (seq !== this.probeSeq) return
          this.applyProbe(result)
        }, (error: unknown) => {
          if (seq !== this.probeSeq) return
          const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : ''
          this.applyProbe({
            ok: false,
            reason: 'unavailable',
            ...message.length > 0 ? { detail: message } : {},
          })
        })
      },
      connectCannlab: () => { void this.connectCannlab(actions) },
      disconnectCannlab: () => { void this.disconnectCannlab() },
      refreshCannlab: () => { void this.refreshCannlab() },
      setCannlabInstance: (text: string) => {
        if (text === this.cannlab.instance) return
        this.cannlab = { ...this.cannlab, instance: text }
        this.store.set(this.projection())
      },
    }
  }

  /**
   * Run the Host connect flow, streaming its log into the panel, then stage the
   * tunnel into the form and save it.
   * @param actions - the form actions, so the staged values persist in one click.
   */
  private async connectCannlab(actions: SettingsFormActions): Promise<void> {
    if (this.cannlab.status === 'running') return
    this.cannlabAbort?.abort()
    const controller = new AbortController()
    this.cannlabAbort = controller
    this.cannlab = {
      ...this.cannlab,
      status: 'running',
      lines: [],
      reason: '',
      authorizeUrl: '',
      applied: '',
    }
    this.store.set(this.projection())
    const result = await this.cannlabApi.connect(this.cannlab.instance.trim(), (event: CannlabEvent) => {
      const line: CannlabLine = {
        level: event.level,
        text: event.message,
        detail: event.detail ?? '',
        at: event.at,
      }
      const authorizeUrl = event.step === 'login-required' || event.step === 'login-awaiting'
        ? (event.detail ?? '')
        : ''
      this.cannlab = {
        ...this.cannlab,
        lines: [...this.cannlab.lines, line],
        ...authorizeUrl.startsWith('http') ? { authorizeUrl } : {},
      }
      this.store.set(this.projection())
    }, controller.signal)
    if (controller.signal.aborted && !result.ok) {
      this.cannlab = { ...this.cannlab, status: 'error', reason: result.reason }
      this.store.set(this.projection())
      return
    }
    if (!result.ok) {
      this.cannlab = { ...this.cannlab, status: 'error', reason: result.reason }
      this.store.set(this.projection())
      return
    }
    this.stageTarget(actions, result.target)
    this.cannlab = {
      ...this.cannlab,
      status: 'ok',
      signedIn: true,
      applied: `${result.target.username}@${result.target.host}:${String(result.target.port)}`,
      reason: '',
    }
    this.store.set(this.projection())
  }

  /**
   * Put a discovered tunnel into the form and save it.
   * A key path is staged, so the auth mode must switch to key first or the
   * save would clear the very path that was just discovered.
   * @param actions - the form actions.
   * @param target - the tunnel the Host opened.
   */
  private stageTarget(actions: SettingsFormActions, target: CannlabTarget): void {
    this.modeOverride = false
    actions.edit('host', target.host)
    actions.edit('port', String(target.port))
    actions.edit('username', target.username)
    actions.edit('privateKeyPath', target.privateKeyPath)
    this.commit()
  }

  /** Save the staged form and show the confirmation when it lands. */
  private commit(): void {
    const actions = this.form.actions()
    if (this.usePasswordNow() && this.form.field('privateKeyPath').text.trim() !== '') {
      actions.edit('privateKeyPath', '')
    }
    const willWrite = this.form.shell().dirty && !this.form.shell().invalid && this.form.shell().writable
    void this.form.save().then(() => {
      const shell = this.form.shell()
      if (!willWrite || shell.failed || shell.dirty || shell.saving) return
      this.savedToken += 1
      this.showSaved = true
      this.store.set(this.projection())
    })
  }

  /** Close the Host's tunnel and forget the staged target. */
  private async disconnectCannlab(): Promise<void> {
    this.cannlabAbort?.abort()
    const ok = await this.cannlabApi.disconnect()
    this.cannlab = {
      ...this.cannlab,
      status: ok ? 'idle' : 'error',
      applied: ok ? '' : this.cannlab.applied,
      reason: ok ? '' : 'the host did not confirm the disconnect',
    }
    this.store.set(this.projection())
  }

  /** Re-read whether a session is stored and whether a tunnel is open. */
  async refreshCannlab(): Promise<void> {
    const status = await this.cannlabApi.status()
    if (status === null) return
    this.cannlab = {
      ...this.cannlab,
      signedIn: status.signedIn,
      account: status.account,
      applied: status.tunnel === null
        ? ''
        : `${status.tunnel.username}@${status.tunnel.host}:${String(status.tunnel.port)}`,
    }
    this.store.set(this.projection())
  }

  /** Store one finished check and publish it. */
  private applyProbe(result: ProbeOutcome): void {
    if (result.ok) {
      this.probeStatus = 'ok'
      this.probeReason = ''
      this.probeDetail = ''
    } else {
      this.probeStatus = 'error'
      this.probeReason = result.reason
      this.probeDetail = result.detail ?? ''
    }
    this.store.set(this.projection())
  }

  /** Release the form and scope subscriptions. */
  dispose(): void {
    // A panel that closes mid-flow must not leave its stream (or the Host's
    // OAuth listener) waiting on a browser the user already walked away from.
    this.cannlabAbort?.abort()
    this.unsubscribeScope()
    this.form.dispose()
  }
}
