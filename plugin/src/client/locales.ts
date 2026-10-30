/** Locale bundles for the CANNESS settings card. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the card renders. */
export type CannessSettingsLocaleKey =
  | 'nav' | 'title' | 'description'
  | 'usePassword' | 'usePasswordHint'
  | 'password' | 'passwordHint' | 'passwordSet' | 'passwordUnset'
  | 'privateKeyPath' | 'privateKeyPathHint'
  | 'host' | 'hostHint' | 'port' | 'portHint' | 'username' | 'usernameHint'
  | 'inbox' | 'inboxHint' | 'outbox' | 'outboxHint'
  | 'advanced'
  | 'timeoutSec' | 'timeoutSecHint' | 'pollIntervalMs' | 'pollIntervalMsHint'
  | 'maxIterations' | 'maxIterationsHint' | 'maxCompileRetries' | 'maxCompileRetriesHint'
  | 'negativeStreakLimit' | 'negativeStreakLimitHint' | 'convergenceThreshold' | 'convergenceThresholdHint'
  | 'overridden' | 'reset' | 'invalid' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed'

/** Simplified Chinese copy. */
export const zh: Record<CannessSettingsLocaleKey, string> = {
  nav: 'CANNESS',
  title: 'CANNESS 远端主机',
  description: '配置远端 NPU 主机的 SSH 连接和评测参数。',
  usePassword: '使用密码认证',
  usePasswordHint: '开启后使用 SSH 密码登录；关闭则使用私钥文件。两者同时配置时优先使用私钥。',
  password: 'SSH 密码',
  passwordHint: '保存在凭据存储中，不写入配置文件。留空表示保持当前密码。',
  passwordSet: '已配置密码',
  passwordUnset: '未配置密码',
  privateKeyPath: '私钥文件路径',
  privateKeyPathHint: '本机私钥文件路径，例如 ~/.ssh/id_rsa。配置后优先使用私钥认证。',
  host: '主机地址',
  hostHint: '远端主机的 IP 或主机名。',
  port: '端口',
  portHint: 'SSH 端口，默认 22。',
  username: '用户名',
  usernameHint: 'SSH 登录用户名。',
  inbox: '收件目录（inbox）',
  inboxHint: '远端接收测试包的目录。',
  outbox: '结果目录（outbox）',
  outboxHint: '远端写回 results.json 的目录。',
  advanced: '高级设置',
  timeoutSec: '等待结果超时（秒）',
  timeoutSecHint: '上传测试包后等待 results.json 的最长时间。',
  pollIntervalMs: '轮询间隔（毫秒）',
  pollIntervalMsHint: '两次查询结果文件之间的间隔。',
  maxIterations: '最大有效迭代数',
  maxIterationsHint: '有效迭代达到该次数后停止生成。',
  maxCompileRetries: '最大编译重试数',
  maxCompileRetriesHint: '编译连续失败的允许次数。',
  negativeStreakLimit: '性能变差连续上限',
  negativeStreakLimitHint: '性能连续变差达到该次数后停止。',
  convergenceThreshold: '收敛阈值',
  convergenceThresholdHint: '两次通过的性能差距小于该比例时判定收敛。',
  overridden: '已覆盖',
  reset: '恢复默认',
  invalid: '输入的值无效。',
  readOnly: '本部署的设置为只读。',
  unavailable: 'CANNESS 插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
}

/** English copy. */
export const en: Record<CannessSettingsLocaleKey, string> = {
  nav: 'CANNESS',
  title: 'CANNESS remote host',
  description: 'Configure the SSH connection and evaluation policy for the remote NPU host.',
  usePassword: 'Use password authentication',
  usePasswordHint: 'On: log in with the SSH password. Off: use a private key file. When both are configured, the private key wins.',
  password: 'SSH password',
  passwordHint: 'Stored in the credentials store, never in the settings file. Leave blank to keep the current password.',
  passwordSet: 'A password is configured.',
  passwordUnset: 'No password is configured.',
  privateKeyPath: 'Private key file path',
  privateKeyPathHint: 'Path to a local private key, e.g. ~/.ssh/id_rsa. Takes priority over the password when set.',
  host: 'Host',
  hostHint: 'IP address or hostname of the remote host.',
  port: 'Port',
  portHint: 'SSH port, default 22.',
  username: 'Username',
  usernameHint: 'SSH login user.',
  inbox: 'Inbox directory',
  inboxHint: 'Remote directory that receives test packages.',
  outbox: 'Outbox directory',
  outboxHint: 'Remote directory where results.json is written back.',
  advanced: 'Advanced',
  timeoutSec: 'Result wait timeout (s)',
  timeoutSecHint: 'How long to wait for results.json after uploading a package.',
  pollIntervalMs: 'Poll interval (ms)',
  pollIntervalMsHint: 'Delay between result-file polls.',
  maxIterations: 'Max valid iterations',
  maxIterationsHint: 'Stop generating once valid iterations reach this count.',
  maxCompileRetries: 'Max compile retries',
  maxCompileRetriesHint: 'Allowed consecutive compile failures.',
  negativeStreakLimit: 'Regression streak limit',
  negativeStreakLimitHint: 'Stop after this many consecutive performance regressions.',
  convergenceThreshold: 'Convergence threshold',
  convergenceThresholdHint: 'Two passes within this fraction of each other count as converged.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  invalid: 'The value is not valid.',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'The CANNESS plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
}

/**
 * The form frame's copy, read from this card's dictionary.
 * @param t - the card's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: CannessSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
