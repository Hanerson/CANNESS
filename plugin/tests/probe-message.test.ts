import { expect, test } from 'vitest'
import { probeMessage } from '../src/client/probe-message.ts'
import { zh, type CannessSettingsLocaleKey } from '../src/client/locales.ts'

const t = (key: CannessSettingsLocaleKey) => zh[key]

test('an unavailable probe shows the specific reason', () => {
  expect(probeMessage(t, 'unavailable', 'command-missing')).toBe(zh.probeCommandMissing)
  expect(probeMessage(t, 'unavailable', 'result-missing')).toBe(zh.probeResultMissing)
  expect(probeMessage(t, 'unavailable', 'list:gateway/internal: session store down'))
    .toBe('无法读取会话列表 (gateway/internal: session store down)')
  expect(probeMessage(t, 'unavailable', 'execute:commands.execute is not a function'))
    .toBe('无法执行探测命令 (commands.execute is not a function)')
  expect(probeMessage(t, 'unavailable', 'socket hang up'))
    .toBe('现在无法发起测试。(socket hang up)')
  expect(probeMessage(t, 'unavailable', '')).toBe('现在无法发起测试。')
})
