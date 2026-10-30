/** The CANNESS settings card: remote-host connection and evaluation policy. */

import { SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { EvalCardFace } from './eval-card-controller.ts'

/** Props the renderer binds for the CANNESS settings section. */
export type EvalCardProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.canness'>
  & InjectFace<EvalCardFace>

/** Render the CANNESS remote-host settings page. */
export function EvalCard(props: EvalCardProps) {
  const { t } = props
  const state = props.useEvalCard(snapshot => snapshot)
  const disabled = !state.writable || state.saving
  return (
    <div>
      <h2>{t('title')}</h2>
      <p>{t('description')}</p>
      <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
        <div>
          <label>
            <span>{t('usePassword')}</span>
            <Switch
              checked={state.usePassword}
              label={t('usePassword')}
              disabled={disabled}
              onChange={(checked) => { props.setUsePassword(checked) }}
            />
          </label>
          <p>{t('usePasswordHint')}</p>
        </div>
        {state.usePassword ? (
          <SettingsSecretField
            id="canness-password"
            label={t('password')}
            hint={t('passwordHint')}
            // Credentials accept a write even when the settings document is
            // read-only; their own writability is what disables this control.
            disabled={!state.passwordWritable}
            text={state.password.text}
            configured={state.passwordConfigured}
            stateLabel={state.passwordConfigured ? t('passwordSet') : t('passwordUnset')}
            onEdit={(text) => { props.edit('password', text) }}
          />
        ) : (
          <SettingsValueField
            id="canness-private-key"
            label={t('privateKeyPath')}
            hint={t('privateKeyPathHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            disabled={disabled}
            {...state.privateKeyPath}
            onEdit={(text) => { props.edit('privateKeyPath', text) }}
            onReset={() => { props.resetField('privateKeyPath') }}
          />
        )}
        <SettingsValueField
          id="canness-host"
          label={t('host')}
          hint={t('hostHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.host}
          onEdit={(text) => { props.edit('host', text) }}
          onReset={() => { props.resetField('host') }}
        />
        <SettingsValueField
          id="canness-port"
          label={t('port')}
          hint={t('portHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          numeric
          disabled={disabled}
          {...state.port}
          onEdit={(text) => { props.edit('port', text) }}
          onReset={() => { props.resetField('port') }}
        />
        <SettingsValueField
          id="canness-username"
          label={t('username')}
          hint={t('usernameHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.username}
          onEdit={(text) => { props.edit('username', text) }}
          onReset={() => { props.resetField('username') }}
        />
        <SettingsValueField
          id="canness-inbox"
          label={t('inbox')}
          hint={t('inboxHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.inbox}
          onEdit={(text) => { props.edit('inbox', text) }}
          onReset={() => { props.resetField('inbox') }}
        />
        <SettingsValueField
          id="canness-outbox"
          label={t('outbox')}
          hint={t('outboxHint')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t('invalid')}
          disabled={disabled}
          {...state.outbox}
          onEdit={(text) => { props.edit('outbox', text) }}
          onReset={() => { props.resetField('outbox') }}
        />
        <details>
          <summary>{t('advanced')}</summary>
          <SettingsValueField
            id="canness-timeout"
            label={t('timeoutSec')}
            hint={t('timeoutSecHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.timeoutSec}
            onEdit={(text) => { props.edit('timeoutSec', text) }}
            onReset={() => { props.resetField('timeoutSec') }}
          />
          <SettingsValueField
            id="canness-poll"
            label={t('pollIntervalMs')}
            hint={t('pollIntervalMsHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.pollIntervalMs}
            onEdit={(text) => { props.edit('pollIntervalMs', text) }}
            onReset={() => { props.resetField('pollIntervalMs') }}
          />
          <SettingsValueField
            id="canness-max-iterations"
            label={t('maxIterations')}
            hint={t('maxIterationsHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.maxIterations}
            onEdit={(text) => { props.edit('maxIterations', text) }}
            onReset={() => { props.resetField('maxIterations') }}
          />
          <SettingsValueField
            id="canness-max-compile"
            label={t('maxCompileRetries')}
            hint={t('maxCompileRetriesHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.maxCompileRetries}
            onEdit={(text) => { props.edit('maxCompileRetries', text) }}
            onReset={() => { props.resetField('maxCompileRetries') }}
          />
          <SettingsValueField
            id="canness-negative-streak"
            label={t('negativeStreakLimit')}
            hint={t('negativeStreakLimitHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.negativeStreakLimit}
            onEdit={(text) => { props.edit('negativeStreakLimit', text) }}
            onReset={() => { props.resetField('negativeStreakLimit') }}
          />
          <SettingsValueField
            id="canness-convergence"
            label={t('convergenceThreshold')}
            hint={t('convergenceThresholdHint')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t('invalid')}
            numeric
            disabled={disabled}
            {...state.convergenceThreshold}
            onEdit={(text) => { props.edit('convergenceThreshold', text) }}
            onReset={() => { props.resetField('convergenceThreshold') }}
          />
        </details>
      </SettingsForm>
    </div>
  )
}
