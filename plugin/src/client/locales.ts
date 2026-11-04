/** Locale bundles for the CANNESS settings card. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the card renders. */
export type CannessSettingsLocaleKey =
  | 'nav' | 'title' | 'description'
  | 'notReady' | 'connection' | 'credentials' | 'directories'
  | 'authMode' | 'authPassword' | 'authKey' | 'authModeHint'
  | 'probe' | 'probing' | 'probeHint' | 'probeOk' | 'probeUnreachable' | 'probeTimeout'
  | 'probeEmptyHost' | 'probeInvalidPort' | 'probeNoSession' | 'probeUnavailable'
  | 'probeCommandMissing' | 'probeListFailed' | 'probeExecuteFailed' | 'probeResultMissing'
  | 'saved'
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
  | 'cannlab' | 'cannlabHint' | 'cannlabConnect' | 'cannlabConnecting' | 'cannlabDisconnect'
  | 'cannlabSignedIn' | 'cannlabSignedOut' | 'cannlabApplied' | 'cannlabFailed' | 'cannlabOpenAuth'
  | 'cannlabLogTitle' | 'cannlabLogEmpty'
  | 'cannlabInstance' | 'cannlabInstancePlaceholder' | 'cannlabInstanceHint'
  | 'badgeReady' | 'badgeNotReady' | 'probeIdle' | 'cannlabMore' | 'cannlabAbout' | 'logCount'

/** Simplified Chinese copy. */
export const zh: Record<CannessSettingsLocaleKey, string> = {
  nav: 'CANNESS',
  title: 'CANNESS 远端主机',
  description: '配置远端 NPU 主机的 SSH 连接和评测参数。配好后，在对话里描述算子需求即可。',
  notReady: '未就绪。还缺主机地址、用户名，或当前认证方式的凭据。',
  connection: '连接',
  credentials: '凭据',
  directories: '远端目录',
  authMode: '认证方式',
  authPassword: '密码',
  authKey: '私钥',
  authModeHint: '选择密码并保存时会清掉私钥路径，这样运行时与这里一致。密码只写入凭据存储。选择私钥时，私钥优先。',
  probe: '测试联通',
  probing: '测试中…',
  probeHint: '用当前填写的主机和端口做一次 TCP 连接，不验证登录。',
  probeOk: '已连通',
  probeUnreachable: '无法连通',
  probeTimeout: '连接超时',
  probeEmptyHost: '请先填写主机地址。',
  probeInvalidPort: '端口需要是 1 到 65535 的整数。',
  probeNoSession: '没有活动会话，无法从本机发起测试。请先打开一个会话。',
  probeUnavailable: '现在无法发起测试。',
  probeCommandMissing: '探测命令未注册。请重新加载 CANNESS 插件后再试。',
  probeListFailed: '无法读取会话列表',
  probeExecuteFailed: '无法执行探测命令',
  probeResultMissing: '探测命令没有返回可识别的结果。',
  saved: '已保存',
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
  cannlab: 'CANNLab 云端环境',
  cannlabHint: 'CANNLab 不开放入站 SSH。点下面一步：浏览器授权 GitCode，自动找到你账号里运行中的环境，经官方端口转发 helper 建立本地隧道，然后把地址、用户名和临时私钥回填到下面的表单并保存。',
  cannlabConnect: '连接到 CANNLab',
  cannlabConnecting: '连接中…',
  cannlabDisconnect: '断开隧道',
  cannlabSignedIn: '已有 GitCode 登录状态',
  cannlabSignedOut: '尚未登录 GitCode',
  cannlabApplied: '当前隧道',
  cannlabFailed: '连接失败',
  cannlabOpenAuth: '如果没有自动打开浏览器，手动打开授权页：',
  cannlabLogTitle: '连接日志（宿主进程逐步输出，便于排查）',
  cannlabLogEmpty: '还没有连接记录。',
  cannlabInstance: '环境名（可选）',
  cannlabInstancePlaceholder: '留空则使用唯一运行中的环境',
  cannlabInstanceHint: '账号里同时有 CPU 和 NPU 两个环境在运行时，在这里写环境名或 ID 指定要连哪一个。',
  badgeReady: '就绪',
  badgeNotReady: '未就绪',
  probeIdle: '尚未测试',
  cannlabMore: '更多选项',
  cannlabAbout: '连接过程说明',
  logCount: '{n} 条',
}

/** English copy. */
export const en: Record<CannessSettingsLocaleKey, string> = {
  nav: 'CANNESS',
  title: 'CANNESS remote host',
  description: 'Configure the SSH connection and evaluation policy for the remote NPU host. After that, describe the operator in the chat.',
  notReady: 'Not ready. The host, username, or credential for the current auth mode is still missing.',
  connection: 'Connection',
  credentials: 'Credentials',
  directories: 'Remote directories',
  authMode: 'Authentication',
  authPassword: 'Password',
  authKey: 'Private key',
  authModeHint: 'Saving with Password clears the private key path, so runtime matches this page. The password is stored only in the credentials store. With Private key selected, the key wins.',
  probe: 'Test connection',
  probing: 'Testing…',
  probeHint: 'Opens one TCP connection to the host and port on this form. It does not log in.',
  probeOk: 'Reachable',
  probeUnreachable: 'Unreachable',
  probeTimeout: 'Connection timed out',
  probeEmptyHost: 'Enter a host first.',
  probeInvalidPort: 'The port must be an integer from 1 to 65535.',
  probeNoSession: 'There is no open session, so this machine cannot start the test. Open a session first.',
  probeUnavailable: 'The test cannot be started right now.',
  probeCommandMissing: 'The probe command is not registered. Reload the CANNESS plugin and try again.',
  probeListFailed: 'The session list could not be read',
  probeExecuteFailed: 'The probe command could not be run',
  probeResultMissing: 'The probe command returned no recognizable result.',
  saved: 'Saved',
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
  cannlab: 'CANNLab cloud environment',
  cannlabHint: 'CANNLab exposes no inbound SSH. One click authorizes GitCode in your browser, finds a running environment in your account, opens a tunnel through the official port-forwarding helper, then fills in the host, user, and temporary key below and saves them.',
  cannlabConnect: 'Connect to CANNLab',
  cannlabConnecting: 'Connecting…',
  cannlabDisconnect: 'Close the tunnel',
  cannlabSignedIn: 'A GitCode session is stored',
  cannlabSignedOut: 'Not signed in to GitCode',
  cannlabApplied: 'Current tunnel',
  cannlabFailed: 'Connect failed',
  cannlabOpenAuth: 'If no browser opened, use this authorization page:',
  cannlabLogTitle: 'Connect log (step by step from the Host process)',
  cannlabLogEmpty: 'No connect attempt yet.',
  cannlabInstance: 'Environment (optional)',
  cannlabInstancePlaceholder: 'Leave blank to use the only running environment',
  cannlabInstanceHint: 'When the account holds both a CPU and an NPU environment, name or id here picks which one to connect.',
  badgeReady: 'Ready',
  badgeNotReady: 'Not ready',
  probeIdle: 'Not tested yet',
  cannlabMore: 'More options',
  cannlabAbout: 'How the connection works',
  logCount: '{n} steps',
}

/**
 * The form frame's copy, read from this card's dictionary.
 * @param t - the card's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: CannessSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
