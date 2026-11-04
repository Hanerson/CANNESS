/**
 * The CANNESS settings page.
 *
 * Layout follows one reading order: what this host is (status), the one action
 * that configures it from scratch (CANNLab), then the fields it fills in, then
 * everything that only matters while diagnosing. Copy that explains rather
 * than reports lives behind a disclosure, so the page reads as a status line
 * plus three short sections instead of a wall of hints.
 */

import { Button, SegmentedControl, SettingsForm, SettingsSecretField, SettingsValueField, StateDot, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels, type CannessSettingsLocaleKey } from './locales.ts'
import type { CannlabLine, EvalCardFace } from './eval-card-controller.ts'
import { probeMessage } from './probe-message.ts'

/** Props the renderer binds for the CANNESS settings section. */
export type EvalCardProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.canness'>
  & InjectFace<EvalCardFace>

type Translate = (key: CannessSettingsLocaleKey) => string

/** Monospace stack for paths and timestamps; the theme exposes no mono token. */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/**
 * Type scale, in one place.
 *
 * Hierarchy is carried by size and weight alone, so the page has three readable
 * levels — section, body, meta — and no decorative colour.
 */
const T = {
  title: { fontSize: 19, fontWeight: 600, lineHeight: 1.35, letterSpacing: '-0.01em' },
  lede: { fontSize: 13, fontWeight: 400, lineHeight: 1.6 },
  section: { fontSize: 12, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0.06em' },
  body: { fontSize: 13, fontWeight: 400, lineHeight: 1.6 },
  strong: { fontSize: 13, fontWeight: 500, lineHeight: 1.5 },
  meta: { fontSize: 11.5, fontWeight: 400, lineHeight: 1.55 },
} as const

/** Layout and surface styles; colours come only from `--dsw-alias-*` tokens. */
const S = {
  page: { maxWidth: 720 },
  lede: { color: 'var(--dsw-alias-label-secondary)', margin: '6px 0 0' },
  status: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 10px',
    marginTop: 18,
    padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: 10,
  },
  statusMeta: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
  statusRule: { flexBasis: '100%', height: 0, borderTop: '1px solid var(--dsw-alias-border-l1)' },
  section: { marginTop: 26 },
  sectionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    paddingBottom: 6,
    marginBottom: 14,
    borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  sectionTitle: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
  sectionTail: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  gap: { marginTop: 10 },
  tunnel: {
    fontFamily: MONO,
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 6,
    padding: '2px 6px',
  },
  disclosure: { marginTop: 14 },
  summary: {
    cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)',
    listStyle: 'none',
    outline: 'none',
  },
  disclosureBody: { marginTop: 10 },
  log: {
    margin: '10px 0 0',
    padding: '10px 12px',
    maxHeight: 240,
    overflowY: 'auto',
    listStyle: 'none',
    fontFamily: MONO,
    fontSize: 11.5,
    lineHeight: 1.7,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
  },
  logLine: { display: 'flex', gap: 8, alignItems: 'baseline' },
  logTime: { color: 'var(--dsw-alias-label-secondary)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  logText: { wordBreak: 'break-word' },
  logDetail: { color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' },
  link: { color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' },
} as const

/** One level's colour: the only thing the log uses colour for. */
function levelColor(level: CannlabLine['level']): string {
  if (level === 'error') return 'var(--dsw-alias-state-error-primary)'
  if (level === 'warn') return 'var(--dsw-alias-state-warn-primary)'
  if (level === 'done') return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-primary)'
}

/**
 * Wall-clock time of one log line, local to the browser.
 * @param at - epoch milliseconds the Host stamped.
 * @returns `HH:MM:SS`, or an empty string for an unusable value.
 */
function stepTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour12: false })
}

/** One section: a small caps-style heading with a hairline rule. */
function Section({ title, tail, children }: { title: string, tail?: string, children: React.ReactNode }) {
  return (
    <section style={S.section}>
      <div style={S.sectionHead}>
        <h3 style={{ ...T.section, ...S.sectionTitle }}>{title}</h3>
        {tail !== undefined && tail.length > 0 ? <span style={{ ...T.meta, ...S.sectionTail }}>{tail}</span> : null}
      </div>
      {children}
    </section>
  )
}

/** One settings value row, with the labels every field on this card shares. */
function valueField(
  id: string,
  label: string,
  hint: string,
  field: SettingsFieldState,
  disabled: boolean,
  t: Translate,
  onEdit: (text: string) => void,
  onReset: () => void,
  numeric = false,
) {
  return (
    <SettingsValueField
      id={id}
      label={label}
      hint={hint}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      invalidLabel={t('invalid')}
      disabled={disabled}
      numeric={numeric}
      {...field}
      onEdit={onEdit}
      onReset={onReset}
    />
  )
}

/** The CANNLab panel: one action, a compact status, and the trace behind a disclosure. */
function CannlabPanel({ state, props, t }: {
  state: ReturnType<EvalCardFace['hooks']['evalCard']['getSnapshot']>
  props: EvalCardProps
  t: Translate
}) {
  const connecting = state.cannlab.status === 'running'
  const last = state.cannlab.lines[state.cannlab.lines.length - 1]
  const logTail = last === undefined
    ? t('cannlabLogEmpty')
    : `${last.text}${last.detail.length > 0 ? ` · ${last.detail}` : ''}`
  return (
    <>
      <p style={{ ...T.body, ...S.statusMeta }}>
        <StateDot state={state.cannlab.signedIn ? 'done' : 'idle'} />
        {' '}
        {state.cannlab.signedIn
          ? `${t('cannlabSignedIn')}${state.cannlab.account.length > 0 ? ` · ${state.cannlab.account}` : ''}`
          : t('cannlabSignedOut')}
        {state.cannlab.applied.length > 0
          ? (
              <>
                <span style={{ color: 'var(--dsw-alias-border-l2)' }}>{'  ·  '}</span>
                {`${t('cannlabApplied')} `}
                <span style={S.tunnel}>{state.cannlab.applied}</span>
              </>
            )
          : null}
      </p>

      <div style={{ ...S.row, ...S.gap }}>
        <Button
          type="button"
          size="md"
          variant={state.cannlab.applied.length > 0 ? 'outline' : 'primary'}
          disabled={connecting || state.saving}
          onClick={() => { props.connectCannlab() }}
        >
          {connecting ? t('cannlabConnecting') : t('cannlabConnect')}
        </Button>
        {state.cannlab.applied.length > 0
          ? (
              <Button
                type="button"
                size="md"
                variant="ghost"
                disabled={connecting}
                onClick={() => { props.disconnectCannlab() }}
              >
                {t('cannlabDisconnect')}
              </Button>
            )
          : null}
      </div>

      {state.cannlab.authorizeUrl.length > 0
        ? (
            <p style={{ ...T.meta, margin: '10px 0 0' }}>
              {`${t('cannlabOpenAuth')} `}
              <a style={S.link} href={state.cannlab.authorizeUrl} target="_blank" rel="noreferrer">{state.cannlab.authorizeUrl}</a>
            </p>
          )
        : null}

      {state.cannlab.status === 'error'
        ? (
            <>
              <p style={{ ...T.meta, color: 'var(--dsw-alias-state-error-primary)', margin: '10px 0 0' }} role="alert">
                {`${t('cannlabFailed')}: ${state.cannlab.reason}`}
              </p>
              {/* A failed attempt opens its trace unconditionally: this is the
                  one moment the log is the whole point, and a disclosure the
                  user must also open hides it exactly then. */}
              <ol style={S.log}>
                {state.cannlab.lines.map((line, index) => (
                  <li key={`${line.at}-${index}`} style={S.logLine}>
                    <span style={S.logTime}>{stepTime(line.at)}</span>
                    <span style={{ ...S.logText, color: levelColor(line.level) }}>{line.text}</span>
                    {line.detail.length > 0 ? <span style={S.logDetail}>{line.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </>
          )
        : (
            <details style={S.disclosure}>
              <summary style={{ ...T.meta, ...S.summary }}>
                {`${t('cannlabLogTitle')} · ${t('logCount').replace('{n}', String(state.cannlab.lines.length))} · ${logTail}`}
              </summary>
              {state.cannlab.lines.length === 0
                ? <p style={{ ...T.meta, margin: '8px 0 0' }}>{t('cannlabLogEmpty')}</p>
                : (
                    <ol style={S.log}>
                      {state.cannlab.lines.map((line, index) => (
                        <li key={`${line.at}-${index}`} style={S.logLine}>
                          <span style={S.logTime}>{stepTime(line.at)}</span>
                          <span style={{ ...S.logText, color: levelColor(line.level) }}>{line.text}</span>
                          {line.detail.length > 0 ? <span style={S.logDetail}>{line.detail}</span> : null}
                        </li>
                      ))}
                    </ol>
                  )}
            </details>
          )}

      <details style={S.disclosure}>
        <summary style={{ ...T.meta, ...S.summary }}>{t('cannlabMore')}</summary>
        <div style={S.disclosureBody}>
          <p style={{ ...T.meta, margin: '0 0 10px' }}>{t('cannlabAbout')}</p>
          <p style={{ ...T.meta, margin: '0 0 12px' }}>{t('cannlabHint')}</p>
          <label htmlFor="canness-cannlab-instance" style={{ ...T.meta, display: 'block', marginBottom: 4 }}>
            {t('cannlabInstance')}
          </label>
          <input
            id="canness-cannlab-instance"
            type="text"
            value={state.cannlab.instance}
            placeholder={t('cannlabInstancePlaceholder')}
            disabled={connecting}
            onChange={(event) => { props.setCannlabInstance(event.currentTarget.value) }}
            style={{
              width: '100%',
              maxWidth: 320,
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '6px 8px',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-layer-1)',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 8,
            }}
          />
          <p style={{ ...T.meta, margin: '6px 0 0' }}>{t('cannlabInstanceHint')}</p>
        </div>
      </details>
    </>
  )
}

/** Render the CANNESS remote-host settings page. */
export function EvalCard(props: EvalCardProps) {
  const { t } = props
  const state = props.useEvalCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  const probing = state.probeStatus === 'running'

  const probeTail = state.probeStatus === 'ok'
    ? t('probeOk')
    : state.probeStatus === 'error' ? probeMessage(t, state.probeReason, state.probeDetail) : t('probeIdle')

  return (
    <div style={S.page}>
      <header>
        <h2 style={{ ...T.title, color: 'var(--dsw-alias-label-primary)', margin: 0 }}>{t('title')}</h2>
        <p style={{ ...T.lede, ...S.lede }}>{t('description')}</p>
      </header>

      {state.available
        ? (
            <div style={S.status}>
              <StateDot state={state.ready ? 'done' : 'warning'} />
              <span style={{ ...T.strong, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }}>
                {state.ready ? state.readyTarget : t('notReady')}
              </span>
              <Tag tone={state.ready ? 'success' : 'warning'}>
                {state.ready ? t('badgeReady') : t('badgeNotReady')}
              </Tag>
              {state.ready ? <span style={{ ...T.meta, color: 'var(--dsw-alias-label-secondary)' }}>{state.readyAuth === 'password' ? t('authPassword') : t('authKey')}</span> : null}
              <span style={S.statusRule} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                title={t('probeHint')}
                disabled={probing || state.saving}
                onClick={() => { props.testConnection() }}
              >
                {probing ? t('probing') : t('probe')}
              </Button>
              <span
                style={{ ...T.meta, color: state.probeStatus === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' }}
                role="status"
              >
                {probeTail}
              </span>
            </div>
          )
        : null}

      <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
        <Section title={t('cannlab')}>
          <CannlabPanel state={state} props={props} t={t} />
        </Section>

        <Section title={t('connection')}>
          {valueField('canness-host', t('host'), t('hostHint'), state.host, disabled, t,
            text => { props.edit('host', text) }, () => { props.resetField('host') })}
          {valueField('canness-port', t('port'), t('portHint'), state.port, disabled, t,
            text => { props.edit('port', text) }, () => { props.resetField('port') }, true)}
          {valueField('canness-username', t('username'), t('usernameHint'), state.username, disabled, t,
            text => { props.edit('username', text) }, () => { props.resetField('username') })}
        </Section>

        <Section title={t('credentials')}>
          <SegmentedControl
            id="canness-auth"
            label={t('authMode')}
            value={state.usePassword ? 'password' : 'key'}
            disabled={disabled}
            options={[
              { value: 'password', label: t('authPassword') },
              { value: 'key', label: t('authKey') },
            ]}
            onChange={(next) => { props.setUsePassword(next === 'password') }}
          />
          <div id="canness-auth-password-panel" role="tabpanel" aria-labelledby="canness-auth-password" hidden={!state.usePassword}>
            {state.usePassword ? (
              <SettingsSecretField
                id="canness-password"
                label={t('password')}
                hint={t('passwordHint')}
                disabled={!state.passwordWritable}
                text={state.password.text}
                configured={state.passwordConfigured}
                stateLabel={state.passwordConfigured ? t('passwordSet') : t('passwordUnset')}
                onEdit={(text) => { props.edit('password', text) }}
              />
            ) : null}
          </div>
          <div id="canness-auth-key-panel" role="tabpanel" aria-labelledby="canness-auth-key" hidden={state.usePassword}>
            {state.usePassword ? null : valueField('canness-private-key', t('privateKeyPath'), t('privateKeyPathHint'), state.privateKeyPath, disabled, t,
              text => { props.edit('privateKeyPath', text) }, () => { props.resetField('privateKeyPath') })}
          </div>
          <details style={S.disclosure}>
            <summary style={{ ...T.meta, ...S.summary }}>{t('authMode')}</summary>
            <p style={{ ...T.meta, margin: '8px 0 0' }}>{t('authModeHint')}</p>
          </details>
        </Section>

        <Section title={t('directories')}>
          {valueField('canness-inbox', t('inbox'), t('inboxHint'), state.inbox, disabled, t,
            text => { props.edit('inbox', text) }, () => { props.resetField('inbox') })}
          {valueField('canness-outbox', t('outbox'), t('outboxHint'), state.outbox, disabled, t,
            text => { props.edit('outbox', text) }, () => { props.resetField('outbox') })}
        </Section>

        <details style={S.disclosure}>
          <summary style={{ ...T.meta, ...S.summary }}>{t('advanced')}</summary>
          <div style={S.disclosureBody}>
            {valueField('canness-timeout', t('timeoutSec'), t('timeoutSecHint'), state.timeoutSec, disabled, t,
              text => { props.edit('timeoutSec', text) }, () => { props.resetField('timeoutSec') }, true)}
            {valueField('canness-poll', t('pollIntervalMs'), t('pollIntervalMsHint'), state.pollIntervalMs, disabled, t,
              text => { props.edit('pollIntervalMs', text) }, () => { props.resetField('pollIntervalMs') }, true)}
            {valueField('canness-max-iterations', t('maxIterations'), t('maxIterationsHint'), state.maxIterations, disabled, t,
              text => { props.edit('maxIterations', text) }, () => { props.resetField('maxIterations') }, true)}
            {valueField('canness-max-compile', t('maxCompileRetries'), t('maxCompileRetriesHint'), state.maxCompileRetries, disabled, t,
              text => { props.edit('maxCompileRetries', text) }, () => { props.resetField('maxCompileRetries') }, true)}
            {valueField('canness-negative-streak', t('negativeStreakLimit'), t('negativeStreakLimitHint'), state.negativeStreakLimit, disabled, t,
              text => { props.edit('negativeStreakLimit', text) }, () => { props.resetField('negativeStreakLimit') }, true)}
            {valueField('canness-convergence', t('convergenceThreshold'), t('convergenceThresholdHint'), state.convergenceThreshold, disabled, t,
              text => { props.edit('convergenceThreshold', text) }, () => { props.resetField('convergenceThreshold') }, true)}
          </div>
        </details>
      </SettingsForm>

      {state.showSaved ? (
        <Toast key={state.savedToken} tone="success" text={t('saved')} onDone={props.dismissSaved} />
      ) : null}
    </div>
  )
}
