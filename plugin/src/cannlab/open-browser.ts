/**
 * Opening the machine's default browser from the Host process.
 *
 * The connect flow's first step happens in a browser, and the Host is the only
 * half of this plugin that can start one. Every platform branch is detached and
 * stdio-free: a launcher that outlives the request must not keep a pipe open.
 */

import { spawn } from 'node:child_process'

/**
 * Launch a URL in the user's default browser.
 * @param url - absolute URL to open.
 * @returns true when a launcher was started; false when none could be.
 */
export async function openExternal(url: string): Promise<boolean> {
  const platform = process.platform
  const command = platform === 'win32'
    ? { file: 'cmd.exe', args: ['/c', 'start', '', url] }
    : platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] }
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
