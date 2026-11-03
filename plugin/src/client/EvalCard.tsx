/** The CANNESS settings card: remote-host connection, credentials, and a TCP reachability check. */

import { Button, SegmentedControl, SettingsForm, SettingsSecretField, SettingsValueField, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsFieldState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels, type CannessSettingsLocaleKey } from './locales.ts'
import type { EvalCardFace } from './eval-card-controller.ts'
import { probeMessage } from './probe-message.ts'

/** Props the renderer binds for the CANNESS settings section. */
export type EvalCardProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.canness'>
  & InjectFace<EvalCardFace>

type Translate = (key: CannessSettingsLocaleKey) => string

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

/** Render the CANNESS remote-host settings page. */
export function EvalCard(props: EvalCardProps) {
  const { t } = props
  const state = props.useEvalCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  const probing = state.probeStatus === 'running'
  return (
    <div>
      <h2>{t('title')}</h2>
      <p>{t('description')}</p>
      <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
        <p role="status">
          <StateDot state={state.ready ? 'done' : 'warning'} />
          {' '}
          {state.ready ? `${state.readyTarget} · ${state.readyAuth === 'password' ? t('authPassword') : t('authKey')}` : t('notReady')}
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={probing || state.saving}
            onClick={() => { props.testConnection() }}
          >
            {probing ? t('probing') : t('probe')}
          </Button>
          <p>{t('probeHint')}</p>
          {state.probeStatus === 'ok' ? <p role="status">{t('probeOk')}</p> : null}
          {state.probeStatus === 'error' ? (
            <p role="status">{probeMessage(t, state.probeReason, state.probeDetail)}</p>
          ) : null}
        </div>
        <h3>{t('connection')}</h3>
        {valueField('canness-host', t('host'), t('hostHint'), state.host, disabled, t,
          text => { props.edit('host', text) }, () => { props.resetField('host') })}
        {valueField('canness-port', t('port'), t('portHint'), state.port, disabled, t,
          text => { props.edit('port', text) }, () => { props.resetField('port') }, true)}
        {valueField('canness-username', t('username'), t('usernameHint'), state.username, disabled, t,
          text => { props.edit('username', text) }, () => { props.resetField('username') })}
        <h3>{t('credentials')}</h3>
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
        <p>{t('authModeHint')}</p>
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
        <h3>{t('directories')}</h3>
        {valueField('canness-inbox', t('inbox'), t('inboxHint'), state.inbox, disabled, t,
          text => { props.edit('inbox', text) }, () => { props.resetField('inbox') })}
        {valueField('canness-outbox', t('outbox'), t('outboxHint'), state.outbox, disabled, t,
          text => { props.edit('outbox', text) }, () => { props.resetField('outbox') })}
        <details>
          <summary>{t('advanced')}</summary>
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
        </details>
      </SettingsForm>
      {state.showSaved ? (
        <Toast key={state.savedToken} tone="success" text={t('saved')} onDone={props.dismissSaved} />
      ) : null}
    </div>
  )
}
