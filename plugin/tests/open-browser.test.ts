/**
 * The browser launcher must not go through a shell.
 *
 * Regression: Windows used `cmd /c start "" <url>`. Node quotes an argument
 * only when it contains whitespace, and an OAuth URL does not, so cmd split the
 * URL at its first `&`: the browser received `...authorize?response_type=code`
 * (no client_id) and GitCode answered "无法找到注册应用进行授权操作", while
 * `client_id=...` was executed as a command. These tests pin the shape of the
 * argv, which is the part that was wrong.
 */

import { describe, expect, it } from 'vitest'
import { browserCommand } from '../src/cannlab/open-browser.js'

const URL_WITH_QUERY
  = 'https://gitcode.com/oauth/authorize?response_type=code&client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A3000%2Fcb&state=deadbeef'

describe('browserCommand', () => {
  it('never routes the URL through cmd.exe on Windows', () => {
    const command = browserCommand('win32', URL_WITH_QUERY)
    expect(command.file.toLowerCase()).not.toContain('cmd')
    expect(command.file.toLowerCase()).not.toContain('powershell')
  })

  it('hands Windows one argument that still carries the whole query string', () => {
    const command = browserCommand('win32', URL_WITH_QUERY)
    const passed = command.args.filter(argument => argument.includes('gitcode.com'))
    expect(passed).toHaveLength(1)
    expect(passed[0]).toBe(URL_WITH_QUERY)
    // The parameters after the first `&` are the ones cmd used to swallow.
    expect(passed[0]).toContain('client_id=abc123')
    expect(passed[0]).toContain('state=deadbeef')
  })

  it('keeps the macOS and Linux launchers shell-free as well', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const command = browserCommand(platform, URL_WITH_QUERY)
      expect(command.args).toEqual([URL_WITH_QUERY])
      expect(command.file).not.toContain('sh')
    }
  })
})
