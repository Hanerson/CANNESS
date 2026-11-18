import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { JsonValue } from './report.js'

/** Compile and exercise the real golden reference, never a simulated NPU API. */
export async function checkGolden(packageDir: string, fixtures: string): Promise<JsonValue> {
  const script = fileURLToPath(new URL('../scripts/check-golden.mjs', import.meta.url))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--package', packageDir, '--fixtures', fixtures],
      { timeout: 125_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    return JSON.parse(stdout)
  } catch (error) {
    const output = (error as { stdout?: string }).stdout
    if (output) { try { return JSON.parse(output) } catch {} }
    return { status: 'unavailable', kernelValidated: false, reason: error instanceof Error ? error.message : 'local golden check failed' }
  }
}

/** Limited host syntax lint. A pass does not establish target API support. */
export async function checkKernel(packageDir: string, dtypes: string[]): Promise<JsonValue> {
  const script = fileURLToPath(new URL('../scripts/check-kernel.mjs', import.meta.url))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--package', packageDir, '--dtypes', dtypes.join(',')],
      { timeout: 125_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
    return JSON.parse(stdout)
  } catch (error) {
    const output = (error as { stdout?: string }).stdout
    if (output) { try { return JSON.parse(output) } catch {} }
    return { status: 'unavailable', targetValidated: false, reason: error instanceof Error ? error.message : 'local kernel lint failed' }
  }
}
