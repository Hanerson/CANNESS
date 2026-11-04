/**
 * Where the GitCode refresh token lives between sessions.
 *
 * Two homes, in order of preference: the Harness credential seam (the same
 * store the CANNESS SSH password uses, so a token never lands in a settings
 * file), and a `0600` JSON file under the Harness home when no provider is
 * mounted. The token is only ever written after a successful sign-in and is
 * deleted by an explicit sign-out.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'

/** Persistence for the one secret this integration keeps. */
export interface TokenStore {
  read(): Promise<string | undefined>
  write(token: string): Promise<void>
  clear(): Promise<void>
  /** Where the token is kept, for the log line that tells a user how to revoke it. */
  describe(): string
}

/** The slice of `ctx.credentials` this store needs. */
interface CredentialsLike {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined>
  set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>
  unset(ref: ReturnType<typeof credentialRef>): Promise<void>
}

/** The Harness home, which is where a fallback secret file may live. */
export function dshHome(): string {
  const declared = process.env.DSH_HOME
  return declared !== undefined && declared.length > 0 ? declared : join(homedir(), '.dsh')
}

/** Absolute path of the fallback token file. */
export function fallbackTokenPath(): string {
  return join(dshHome(), 'canness', 'cannlab-token.json')
}

/**
 * A token store over the Harness credential seam.
 * @param credentials - the mounted provider.
 * @param ref - declared credential reference name.
 */
export class CredentialsTokenStore implements TokenStore {
  private readonly branded: ReturnType<typeof credentialRef>

  constructor(private readonly credentials: CredentialsLike, ref: string) {
    this.branded = credentialRef(ref)
  }

  /** @returns the stored refresh token, or undefined when none is stored. */
  async read(): Promise<string | undefined> {
    try {
      const hit = await this.credentials.resolve(this.branded)
      const value = hit?.value
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      // An unreadable provider reads as "not signed in": the flow then offers
      // an interactive sign-in instead of failing before the browser opens.
      return undefined
    }
  }

  /** @param token - refresh token to persist. */
  async write(token: string): Promise<void> {
    await this.credentials.set(this.branded, token)
  }

  /** Remove the stored token. */
  async clear(): Promise<void> {
    await this.credentials.unset(this.branded)
  }

  /** @returns a sentence naming the credential reference. */
  describe(): string {
    return `harness credential ${String(this.branded)}`
  }
}

/** Format of the fallback file; `version` guards a future migration. */
interface TokenFile {
  version: 1
  refreshToken: string
  savedAt: string
}

/**
 * A `0600` JSON file under the Harness home.
 * @param path - absolute file path.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string = fallbackTokenPath()) {}

  /** @returns the stored refresh token, or undefined when the file is absent or unreadable. */
  async read(): Promise<string | undefined> {
    if (!existsSync(this.path)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<TokenFile>
      return typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0 ? parsed.refreshToken : undefined
    } catch {
      return undefined
    }
  }

  /** @param token - refresh token to persist. */
  async write(token: string): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const body: TokenFile = { version: 1, refreshToken: token, savedAt: new Date().toISOString() }
    writeFileSync(this.path, JSON.stringify(body, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // Windows has no POSIX mode; the ACL inherited from the profile directory applies.
    }
  }

  /** Remove the stored token. */
  async clear(): Promise<void> {
    rmSync(this.path, { force: true })
  }

  /** @returns the absolute path the token file uses. */
  describe(): string {
    return `file ${this.path}`
  }
}

/**
 * Choose the token store this deployment can actually use.
 * @param ctx - the plugin context, whose `credentials` service may be absent in a minimal profile.
 * @param ref - declared credential reference name; a name outside the grammar skips the seam.
 * @returns the credential-backed store when available, otherwise the file store.
 */
export function createTokenStore(ctx: Context, ref: string): TokenStore {
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (credentials !== undefined && isCredentialRefName(ref)
    && typeof credentials.resolve === 'function' && typeof credentials.set === 'function') {
    return new CredentialsTokenStore(credentials, ref)
  }
  return new FileTokenStore()
}
