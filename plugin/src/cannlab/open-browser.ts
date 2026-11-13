/**
 * Opening the machine's default browser from the Host process.
 *
 * The connect flow's first step happens in a browser, and the Host is the only
 * half of this plugin that can start one. Every platform branch is detached and
 * stdio-free: a launcher that outlives the request must not keep a pipe open.
 *
 * Nothing here may go through a command interpreter. Windows' `cmd /c start`
 * splits the URL at its first `&` — Node only quotes arguments that contain
 * whitespace, and an OAuth URL contains none — so the browser opened
 * `...authorize?response_type=code` and GitCode answered "cannot find the
 * registered application" because `client_id` had been dropped and handed to
 * cmd as a command of its own. `rundll32` takes the URL as one argument and
 * parses nothing.
 */

import { spawn } from 'node:child_process'

/** The launcher to try, and the argv it needs. */
export interface BrowserCommand {
  file: string
  args: string[]
}

/**
 * The launcher for one platform.
 *
 * Exported so a test can hold the shape of the argv: the URL must arrive as a
 * single element that still contains its query string, which is exactly what
 * the `cmd /c start` form broke.
 * @param platform - `process.platform`, injected for tests.
 * @param url - absolute URL to open.
 * @returns the program and its arguments.
 */
export function browserCommand(platform: NodeJS.Platform, url: string): BrowserCommand {
  if (platform === 'win32') {
    // No shell: `&` stays inside the URL instead of becoming a command separator.
    return { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
  }
  if (platform === 'darwin') return { file: 'open', args: [url] }
  return { file: 'xdg-open', args: [url] }
}

/**
 * Launch a URL in the user's default browser.
 * @param url - absolute URL to open.
 * @returns true when a launcher was started; false when none could be.
 */
export async function openExternal(url: string): Promise<boolean> {
  const command = browserCommand(process.platform, url)
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.file, command.args, { detached: true, stdio: 'ignore' })
      child.once('error', () => { resolve(false) })
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}
