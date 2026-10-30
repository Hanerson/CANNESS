# CANNESS SSH Password Auth & Web Settings Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `run_evaluation` supports SSH password auth resolved through the dsh credentials seam, and a CANNESS settings card in the dsh Web UI edits the remote-host config without touching files.

**Architecture:** The eval plugin's editable Config fields become schemastery `.volatile()` fields (required: dsh's settings service refuses writes to non-volatile fields), read per-operation through `.get()`. Password values live only in the credentials store (`~/.dsh/.credentials.yaml`), referenced by the `passwordEnv` config name; auth priority is private key → password → error. A browser half (`src/client/`, built to `lib/client.js` in dsh's lazy-CJS factory format by esbuild) registers a `settings.section` card that stages edits through `ctx.configForms` (settings mutate → profile patch) and writes the password through `ctx.remote.credentials.set`.

**Tech Stack:** TypeScript/ESM, schemastery volatile fields, ssh2, esbuild (client bundle), React 18 (browser half, externals from dsh's frozen module table), vitest.

**Spec:** `docs/superpowers/specs/2026-10-30-canness-ssh-credentials-design.md` (approved). Deviations discovered during exploration are recorded in "Deviations from the spec" below — all are mechanism-level corrections, not scope changes.

## Global Constraints

- Branch: `feat/canness-ssh-password-auth`. Package `dsh-canness`, engines `dsh >=0.2.0 <0.3.0`, node `>=24.9.0` (already in package.json).
- dsh plugins are TypeScript/ESM only. dsh package versions pinned at `0.2.1-rc.3`, cordis `4.0.5`, schemastery `3.18.5` (match existing pins).
- Password values NEVER appear in config files, tool output, or settings responses. Only the credentials seam stores them; config carries only the reference name (`passwordEnv`).
- The client bundle must not value-import any package outside dsh's frozen module table (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`). Everything else inlines. Cross-plugin collaboration goes through cordis services (`ctx.configForms`, `ctx.remote`).
- No custom CSS: use dsh primitives' built-in styling plus a native `<details>` for the advanced area. This keeps the external build free of dsh's internal CSS-modules pipeline.
- UI copy is Chinese-first (`zh`) with an `en` dictionary, following dsh client package locale structure.
- Every task ends with `pnpm test` green. Full check: `pnpm test` + `pnpm exec tsc -p tsconfig.json --noEmit` + `pnpm exec tsc -p tsconfig.client.json --noEmit` + `pnpm build`.
- Comments and identifiers in English (match existing plugin code); user-visible card copy in Chinese.

## Deviations from the spec (found during dsh source exploration)

1. **All editable fields must be `.volatile()`, not just `passwordEnv`.** `packages/settings/settings/src/index.ts` `write()` rejects any non-volatile path (`Config field "host" is not volatile`). Since the card edits host/port/username/privateKeyPath/inbox/outbox and the policy numbers, every one of those schema fields gets `.volatile()`. The plugin then receives `Volatile<T>` references and reads them via `.get()` per operation — which is exactly the "改配置不重启生效" behavior the spec wants.
2. **The card writes field-level path ops (settings `mutate`), not a whole-section replace.** The spec's "整段替换" describes patch-layer semantics; the settings API's `mutate` with per-field ops is the standard flow every dsh settings card uses (revision-fenced, partial-view safe). Net effect identical: one source of truth in the profile patch.
3. **A fifth patch row with the bare package name is required.** dsh's client-module system attaches a browser half only to the Loader row whose specifier is the bare package name (`dsh-canness`); the four existing rows are subpath exports (`dsh-canness/eval`) and never carry one. We add `- id: canness, name: dsh-canness` backed by a new root entry with an empty `apply` (same pattern as `@deepseek-ai/dsh-client-ui-settings-web-search`'s node half).
4. **认证方式单选 implemented as a `Switch` ("使用密码认证") with derived initial state.** Toggling only switches which credential field is visible (local state, nothing staged or persisted); Node-side priority is unchanged and stated in the hint copy. The spec's radio semantics are fully covered by a boolean toggle between the two modes.
5. **The Plugins page will also auto-generate a generic config form for `canness-eval`** once its fields are volatile (standard dsh behavior, `autoGenerate` default). Harmless: same namespace, same revision fence, shared mirror. We do not disable it.

## File Structure

```
plugin/
├── package.json                 # MODIFY: exports "."/"./client", dsh.client, deps, scripts
├── cordis.patch.yml              # MODIFY: add bare row `- id: canness / name: dsh-canness`
├── tsconfig.json                 # MODIFY: exclude src/client
├── tsconfig.client.json          # CREATE: type-check the browser half
├── scripts/build-client.mjs      # CREATE: esbuild → lib/client.js factory bundle
├── README.md                     # MODIFY: password auth + settings card docs
├── src/
│   ├── index.ts                  # CREATE: root entry, empty apply (carries the client half)
│   ├── eval.ts                   # MODIFY: volatile config, password resolution, error reports
│   ├── ssh2-transport.ts         # MODIFY: optional privateKey, add password
│   └── client/
│       ├── index.ts              # CREATE: browser half apply (locale, controller, slot registration)
│       ├── locales.ts            # CREATE: zh + en dictionaries + formLabels
│       ├── eval-card-controller.ts # CREATE: staged form + credential bridge
│       └── EvalCard.tsx          # CREATE: the settings card component
└── tests/
    ├── ssh2-transport.test.ts    # MODIFY: password passthrough tests
    ├── plugins.test.ts           # MODIFY: volatile fixtures, auth priority tests
    ├── scaffold.test.ts          # MODIFY: manifest assertions
    └── eval-card.test.ts         # CREATE: save-splitting controller tests
```

Responsibilities: `ssh2-transport.ts` owns dial options only; `eval.ts` owns config shape, auth priority, and tool behavior; `eval-card-controller.ts` owns staging/分流 (password → credentials, rest → settings mutate); `EvalCard.tsx` owns rendering only; `client/index.ts` owns registration lifecycle.

---

### Task 1: ssh2 transport password support

**Files:**
- Modify: `plugin/src/ssh2-transport.ts`
- Test: `plugin/tests/ssh2-transport.test.ts`

**Interfaces:**
- Produces: `SftpOptions { host: string; port: number; username: string; privateKey?: string; password?: string }` (Task 2's `connect` call and Task 2 tests rely on both auth fields being optional). `openSftp`/`connectSftp`/`remoteFromSftp` signatures otherwise unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `plugin/tests/ssh2-transport.test.ts` (and extend `fakeClient` to record the connect config):

```ts
test('openSftp passes password auth through and omits the key', async () => {
  const client = fakeClient(cb => {
    cb(undefined, { unlink(_path, done) { done(null) } })
  })
  const files = remoteFromSftp(await openSftp(client, {
    host: 'npu', port: 22, username: 'canness', password: 'pw',
  }))
  expect(client.connectConfig).toMatchObject({ host: 'npu', port: 22, username: 'canness', password: 'pw' })
  expect(client.connectConfig).not.toHaveProperty('privateKey')
  await files.close()
})

test('openSftp keeps passing the private key when present', async () => {
  const client = fakeClient(cb => {
    cb(undefined, { unlink(_path, done) { done(null) } })
  })
  await openSftp(client, { host: 'npu', port: 22, username: 'canness', privateKey: 'KEY' })
  expect(client.connectConfig).toMatchObject({ privateKey: 'KEY' })
  expect(client.connectConfig).not.toHaveProperty('password')
})
```

Change `fakeClient` to capture the config its `connect` receives:

```ts
function fakeClient(start: (cb: (err: Error | undefined, sftp: { unlink: (path: string, done: (err?: Error | null) => void) => void }) => void) => void) {
  const handlers = new Map<string, Function>()
  const client = {
    ends: 0,
    connectConfig: undefined as { host?: string; port?: number; username?: string; privateKey?: string; password?: string } | undefined,
    on(event: string, fn: Function) {
      handlers.set(event, fn)
      return client
    },
    connect(config: object) {
      client.connectConfig = config as typeof client.connectConfig
      handlers.get('ready')?.()
      return client
    },
    sftp(cb: (err: Error | undefined, sftp: { unlink: (path: string, done: (err?: Error | null) => void) => void }) => void) {
      start(cb)
    },
    end() {
      client.ends += 1
    },
  }
  return client
}
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `cd plugin && pnpm vitest run tests/ssh2-transport.test.ts`
Expected: the two new tests FAIL (`connectConfig` stays `undefined` because the current `connect(config)` signature ignores its argument — TypeScript may also flag `password` as unknown in `SftpOptions`).

- [ ] **Step 3: Implement**

In `plugin/src/ssh2-transport.ts`:

```ts
export interface SftpOptions {
  host: string
  port: number
  username: string
  privateKey?: string
  password?: string
}
```

Change the `DialClient` interface's connect member:

```ts
interface DialClient {
  on(event: 'ready', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  connect(config: { host: string; port: number; username: string; privateKey?: string; password?: string }): this
  sftp(callback: (err: Error | undefined, sftp: SFTPWrapper) => void): this
  end(): void
}
```

In `openSftp`, replace the `.connect({...})` call:

```ts
    }).on('error', reject).connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      ...(opts.privateKey !== undefined ? { privateKey: opts.privateKey } : {}),
      ...(opts.password !== undefined ? { password: opts.password } : {}),
    })
```

(Conditional spread so an absent method never reaches ssh2 — ssh2 reports "All configured authentication methods failed" when neither is given, which is the behavior the spec's error table relies on.)

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `cd plugin && pnpm test`
Expected: all existing tests plus the two new ones PASS (existing `dialOpts` fixtures still satisfy the now-optional `privateKey`).

- [ ] **Step 5: Commit**

```bash
git add plugin/src/ssh2-transport.ts plugin/tests/ssh2-transport.test.ts
git commit -m "feat: dial sftp with a password"
```

---

### Task 2: volatile eval config and credentials-seam password resolution

**Files:**
- Modify: `plugin/src/eval.ts`
- Test: `plugin/tests/plugins.test.ts`
- Modify: `plugin/package.json` (add the `@deepseek-ai/dsh-credentials` dependency)

**Interfaces:**
- Consumes: `SftpOptions` from Task 1 (optional `privateKey`/`password`).
- Produces: `Config` with `Volatile<T>` fields (Task 3's settings card and Task 4's controller edit the `canness-eval` namespace these fields expose); `apply(ctx, config, connect)` signature unchanged (third parameter stays the injected dial). Auth priority: `privateKeyPath` non-empty → key; else credentials-resolved `passwordEnv` → password; neither → `status: 'error'`, `summary: 'ssh credentials missing'`. Connect failures return `status: 'error'`, `summary: 'ssh connect failed: <reason>'`.

- [ ] **Step 1: Add the dependency**

```bash
cd plugin && pnpm add @deepseek-ai/dsh-credentials@0.2.1-rc.3
```

Then edit `plugin/package.json` to move `"@deepseek-ai/dsh-credentials": "0.2.1-rc.3"` from `dependencies` into BOTH `peerDependencies` and keep it in `devDependencies` as well (add it there; the runtime copy comes from the host install). This follows the harness rule: dsh packages whose instances must be shared (credential branding) are peers; the devDependency serves local type checking and tests. `ssh2` stays the only plain `dependencies` entry.

- [ ] **Step 2: Write the failing tests**

Rework `plugin/tests/plugins.test.ts`. First the helpers (top of file, after imports):

```ts
import type { Volatile } from '@deepseek-ai/cordis'

const vol = <T,>(value: T): Volatile<T> => ({ get: () => value })

function evalConfig(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    workspace,
    host: vol('npu'), port: vol(22), username: vol('canness'),
    privateKeyPath: vol(''), passwordEnv: vol('CANNNESS_SSH_PASSWORD'),
    inbox: vol('/in'), outbox: vol('/out'), timeoutSec: vol(0), pollIntervalMs: vol(1),
    maxIterations: vol(10), maxCompileRetries: vol(3), negativeStreakLimit: vol(3), convergenceThreshold: vol(0.05),
    ...overrides,
  }
}
```

Extend `fakeCtx` with an optional credentials service and a `get` method:

```ts
function fakeCtx(credentials?: { resolve: (ref: string) => Promise<{ value: string } | undefined> }) {
  const tools: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }[] = []
  const listeners: { event: string; fn: Function }[] = []
  return {
    tools: { register(tool: { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }) { tools.push(tool) } },
    on(event: string, fn: Function) { listeners.push({ event, fn }) },
    get(name: string) { return name === 'credentials' ? credentials : undefined },
    toolsRegistered: tools,
    listeners,
  }
}
```

Update every existing `evalPlugin.apply(...)` call site to use `evalConfig(workspace, { host: vol('') })` for the empty-host tests and `evalConfig(workspace, { privateKeyPath: vol(join(workspace, 'id_key')) })` for the key-based ones (keep each test's existing `timeoutSec`/`inbox`/`outbox` values as overrides where they differ). `readyPackage()` keeps writing `id_key`; the finished/failed/timeout/stopped tests keep `privateKeyPath: vol(join(finished.workspace, 'id_key'))`.

New tests (append near the other run_evaluation tests; they reuse `readyPackage()`):

```ts
function keyFile(workspace: string): string {
  writeFileSync(join(workspace, 'id_key'), 'KEY')
  return join(workspace, 'id_key')
}

test('the private key wins over a stored password', async () => {
  const pkg = readyPackage()
  const connected: unknown[] = []
  const ctx = fakeCtx({ resolve: async () => ({ value: 'pw' }) })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(keyFile(pkg.workspace)) }),
    async opts => { connected.push(opts); return trackedRemote([]).files })
  await ctx.toolsRegistered[0]!.execute({})
  expect(connected[0]).toMatchObject({ privateKey: 'KEY' })
  expect((connected[0] as Record<string, unknown>).password).toBeUndefined()
})

```ts
test('a stored password is used when no key path is configured', async () => {
  const pkg = readyPackage()
  const refs: string[] = []
  const connected: unknown[] = []
  const ctx = fakeCtx({ resolve: async ref => { refs.push(String(ref)); return { value: 'pw' } } })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async opts => { connected.push(opts); return trackedRemote([]).files })
  await ctx.toolsRegistered[0]!.execute({})
  expect(refs).toEqual(['CANNNESS_SSH_PASSWORD'])
  expect(connected[0]).toMatchObject({ password: 'pw' })
  expect((connected[0] as Record<string, unknown>).privateKey).toBeUndefined()
})

test('both credentials missing reports ssh credentials missing without connecting', async () => {
  const pkg = readyPackage()
  let connected = false
  const ctx = fakeCtx({ resolve: async () => undefined })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async () => { connected = true; throw new Error('connected') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh credentials missing' })
  expect(connected).toBe(false)
})

test('an absent credentials service degrades to the missing-credentials report', async () => {
  const pkg = readyPackage()
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol('') }),
    async () => { throw new Error('connected') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error', summary: 'ssh credentials missing' })
})

test('a connect failure becomes an error report carrying the reason', async () => {
  const pkg = readyPackage()
  const ctx = fakeCtx()
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(keyFile(pkg.workspace)) }),
    async () => { throw new Error('All configured authentication methods failed') })
  const value = await ctx.toolsRegistered[0]!.execute({})
  expect(value).toMatchObject({ status: 'error' })
  expect((value as { summary: string }).summary).toContain('All configured authentication methods failed')
})
```

Also add a `passwordEnv` ref-name test:

```ts
test('passwordEnv names the resolved reference', async () => {
  const pkg = readyPackage()
  const refs: string[] = []
  const ctx = fakeCtx({ resolve: async ref => { refs.push(String(ref)); return { value: 'pw' } } })
  evalPlugin.apply(ctx as never, evalConfig(pkg.workspace, { privateKeyPath: vol(''), passwordEnv: vol('CUSTOM_SSH_REF') }),
    async () => trackedRemote([]).files)
  await ctx.toolsRegistered[0]!.execute({})
  expect(refs).toEqual(['CUSTOM_SSH_REF'])
})
```

- [ ] **Step 3: Run the tests, confirm they fail**

Run: `cd plugin && pnpm vitest run tests/plugins.test.ts`
Expected: FAIL — new tests error (e.g. `config.host.get is not a function` on plain fixtures, `passwordEnv` unknown, `ctx.get` missing on old fakes) and `pnpm exec tsc -p tsconfig.json --noEmit` reports `password` not in `SftpOptions`-adjacent call sites.

- [ ] **Step 4: Implement `plugin/src/eval.ts`**

Full new content of the sections that change (keep `emptyHostReport`, the tool schema/render blocks, and the overall `apply` structure):

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { runEvaluation } from './eval-run.js'
import { loadState, saveState } from './state-file.js'
import { connectSftp, type SftpOptions } from './ssh2-transport.js'
import type { RemoteFiles } from './remote.js'
import { stoppedReport, type EvalReport } from './report.js'
import { stopReason, type PolicyConfig } from './policy.js'

export const name = 'canness-eval'
export const inject = ['tools']

// Every field the settings card edits must be volatile: the dsh settings
// service refuses writes to non-volatile paths, and volatile references are
// re-read per operation so a card save takes effect without a remount.
export interface Config {
  workspace: string
  host: Volatile<string>
  port: Volatile<number>
  username: Volatile<string>
  privateKeyPath: Volatile<string>
  passwordEnv: Volatile<string>
  inbox: Volatile<string>
  outbox: Volatile<string>
  timeoutSec: Volatile<number>
  pollIntervalMs: Volatile<number>
  maxIterations: Volatile<number>
  maxCompileRetries: Volatile<number>
  negativeStreakLimit: Volatile<number>
  convergenceThreshold: Volatile<number>
}

export const Config = z.object({
  workspace: z.string().required(),
  host: z.string().required().volatile(),
  port: z.number().required().volatile(),
  username: z.string().required().volatile(),
  privateKeyPath: z.string().required().volatile(),
  passwordEnv: z.string().role('credential-ref').default('CANNNESS_SSH_PASSWORD').volatile(),
  inbox: z.string().required().volatile(),
  outbox: z.string().required().volatile(),
  timeoutSec: z.number().required().volatile(),
  pollIntervalMs: z.number().required().volatile(),
  maxIterations: z.number().required().volatile(),
  maxCompileRetries: z.number().required().volatile(),
  negativeStreakLimit: z.number().required().volatile(),
  convergenceThreshold: z.number().required().volatile(),
})
```

If `tsc` rejects the removed `z<Config>` annotation shape (the old file had `export const Config: z<Config>`), keep the annotation only if it still checks; the dsh cookbook's volatile examples use the un-annotated form, and the interface stays exported for consumers.

Snapshot + auth helpers:

```ts
/** One consistent read of the volatile fields, captured when an operation starts. */
function snapshot(config: Config) {
  return {
    host: config.host.get(),
    port: config.port.get(),
    username: config.username.get(),
    privateKeyPath: config.privateKeyPath.get(),
    passwordEnv: config.passwordEnv.get(),
    inbox: config.inbox.get(),
    outbox: config.outbox.get(),
    timeoutSec: config.timeoutSec.get(),
    pollIntervalMs: config.pollIntervalMs.get(),
  }
}

function policyOf(config: Config): PolicyConfig {
  return {
    maxIterations: config.maxIterations.get(),
    maxCompileRetries: config.maxCompileRetries.get(),
    negativeStreakLimit: config.negativeStreakLimit.get(),
    convergenceThreshold: config.convergenceThreshold.get(),
  }
}

/** Private key when a path is configured, otherwise the credentials-seam password. */
async function resolveAuth(ctx: Context, cfg: ReturnType<typeof snapshot>): Promise<Pick<SftpOptions, 'privateKey' | 'password'>> {
  if (cfg.privateKeyPath !== '') return { privateKey: readFileSync(cfg.privateKeyPath, 'utf8') }
  const credentials = ctx.get('credentials')
  // No provider mounted (minimal profile) or no value stored both read as "not configured".
  if (credentials === undefined || !isCredentialRefName(cfg.passwordEnv)) return {}
  const hit = await credentials.resolve(credentialRef(cfg.passwordEnv))
  return hit === undefined ? {} : { password: hit.value }
}
```

Reports (beside `emptyHostReport`):

```ts
function missingCredentialsReport(generationId: string | null): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: 'ssh credentials missing',
  }
}

function connectFailedReport(generationId: string | null, detail: string): EvalReport {
  return {
    generationId: generationId ?? 'unknown',
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `ssh connect failed: ${detail}`,
  }
}
```

In `apply`, drop the module-level `const policy` (now per-operation) and rewrite `execute`:

```ts
    async execute() {
      const cfg = snapshot(config)
      const state = loadState(path)
      if (cfg.host === '') return emptyHostReport(state.generationId)
      if (state.generationId == null) throw new Error('submit_spec first')
      const localPackageDir = join(config.workspace, 'packages', state.generationId)
      if (!existsSync(localPackageDir)) throw new Error('build_test_package first')
      const reason = stopReason(state, policyOf(config))
      if (reason) return stoppedReport(state.generationId, reason)
      const auth = await resolveAuth(ctx, cfg)
      if (auth.privateKey === undefined && auth.password === undefined) {
        return missingCredentialsReport(state.generationId)
      }
      let files: RemoteFiles
      try {
        files = await connect({ host: cfg.host, port: cfg.port, username: cfg.username, ...auth })
      } catch (error) {
        return connectFailedReport(state.generationId, error instanceof Error ? error.message : 'unknown')
      }
      try {
        const { report, state: next } = await runEvaluation({
          files,
          localPackageDir,
          generationId: state.generationId,
          inbox: cfg.inbox,
          outbox: cfg.outbox,
          timeoutMs: cfg.timeoutSec * 1000,
          intervalMs: cfg.pollIntervalMs,
          state,
          config: policyOf(config),
        })
        saveState(path, next)
        return report
      } finally {
        await files.close()
      }
    },
```

`apply`'s `connect` parameter stays `(opts: SftpOptions) => Promise<RemoteFiles> = connectSftp`.

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `cd plugin && pnpm test && pnpm exec tsc -p tsconfig.json --noEmit`
Expected: all PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add plugin/src/eval.ts plugin/tests/plugins.test.ts plugin/package.json plugin/pnpm-lock.yaml
git commit -m "feat: resolve the ssh password through the credentials seam"
```

---

### Task 3: package manifest, root entry, and client build plumbing

**Files:**
- Modify: `plugin/package.json`, `plugin/cordis.patch.yml`, `plugin/tsconfig.json`
- Create: `plugin/src/index.ts`, `plugin/src/client/index.ts` (placeholder, filled in Task 4), `plugin/tsconfig.client.json`, `plugin/scripts/build-client.mjs`
- Test: `plugin/tests/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `exports["."]` → `./lib/index.js` (empty-apply root entry), `exports["./client"]` → `./lib/client.js` (browser bundle), `dsh.client` declaration `{ platform: "web", inject: ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-api-remotes"] }`, devDeps the client half needs (Task 4 imports them), `pnpm build` producing both `lib/*.js` (tsc) and `lib/client.js` (esbuild), and `tsconfig.client.json` for the browser-half type check.

- [ ] **Step 1: Write the failing test**

Update `plugin/tests/scaffold.test.ts`:

```ts
test('package declares the dsh bundle and four entries', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(pkg.name).toBe('dsh-canness')
  expect(pkg.type).toBe('module')
  expect(pkg.engines.node).toBe('>=24.9.0')
  expect(pkg.engines.dsh).toBe('>=0.2.0 <0.3.0')
  expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  expect(pkg.exports['.']).toBe('./lib/index.js')
  expect(pkg.exports['./knowledge']).toBe('./lib/knowledge.js')
  expect(pkg.exports['./generator']).toBe('./lib/generator.js')
  expect(pkg.exports['./eval']).toBe('./lib/eval.js')
  expect(pkg.exports['./loop']).toBe('./lib/loop.js')
  expect(pkg.exports['./client']).toBe('./lib/client.js')
  expect(pkg.dsh.client.platform).toBe('web')
  expect(pkg.dsh.client.inject).toEqual([
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-api-remotes',
  ])
})
```

Also add a patch-row assertion (reads `cordis.patch.yml` as text):

```ts
test('the patch carries the bare package row for the client half', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  expect(patch).toContain('- id: canness\n      name: dsh-canness\n')
})
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd plugin && pnpm vitest run tests/scaffold.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

`plugin/package.json` — add to `exports` (keeping the four existing entries):

```json
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
```

Add the client declaration inside `dsh`:

```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-api-remotes"
      ]
    }
  },
```

Update `scripts`:

```json
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json && node scripts/build-client.mjs",
    "check": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.client.json --noEmit"
  },
```

Add devDependencies and install:

```bash
cd plugin && pnpm add -D react@^18.2.0 esbuild@^0.25.0 \
  @deepseek-ai/dsh-client-store@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-primitives@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-slots@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-settings@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-locale@0.2.1-rc.3 \
  @deepseek-ai/dsh-client-ui-renderer@0.2.1-rc.3 \
  @deepseek-ai/dsh-api-remotes@0.2.1-rc.3
```

`plugin/src/index.ts` (new root entry — the Loader row whose specifier is the bare package name; its browser half is the settings card):

```ts
/**
 * Root entry of dsh-canness: an empty Host apply so the bare-package-name
 * Loader row exists — the client module system attaches the browser half
 * (exports["./client"], the CANNESS settings card) only to that row.
 */
export function apply(): void {}
```

`plugin/src/client/index.ts` (placeholder until Task 4):

```ts
/** Browser half of dsh-canness — filled in by the settings-card task. */
export const inject = [] as const

export function apply(): void {}
```

`plugin/cordis.patch.yml` — add the bare row FIRST in the insert list (before `canness-knowledge`):

```yaml
- insert:
    - id: canness
      name: dsh-canness
    - id: canness-knowledge
      name: dsh-canness/knowledge
      config:
        kbRoot: ./plugin/knowledge_base
    # ... remaining rows unchanged
```

`plugin/tsconfig.json` — keep `"include": ["src"]`, add:

```json
  "exclude": ["src/client"]
```

`plugin/tsconfig.client.json` (new):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/client"]
}
```

`plugin/scripts/build-client.mjs` (new — reproduces dsh's client-bundle contract: lazy-CJS factory registered with `window.__ModuleLoader__`, externals limited to the frozen module table):

```js
// Builds lib/client.js in the dsh client module system's factory format:
// window.__ModuleLoader__.load({ id, factory: (require) => { ... } }).
// Externals are exactly the browser platform's frozen module table; every
// other import inlines. The bundle must contain no dynamic imports.
import { build } from 'esbuild'

const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'lib/client.js',
  sourcemap: true,
  external: PLATFORM_MODULES,
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-canness", factory: (require) => {\n'
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
```

- [ ] **Step 4: Run the tests and the build, confirm they pass**

Run: `cd plugin && pnpm test && pnpm build && pnpm run check`
Expected: scaffold test PASS; `lib/index.js` and `lib/client.js` both produced; both tsc configs exit 0.

- [ ] **Step 5: Commit**

```bash
git add plugin/package.json plugin/pnpm-lock.yaml plugin/cordis.patch.yml plugin/tsconfig.json plugin/tsconfig.client.json plugin/src/index.ts plugin/src/client/index.ts plugin/scripts/build-client.mjs plugin/tests/scaffold.test.ts
git commit -m "feat: declare the canness web client half"
```

---

### Task 4: the CANNESS settings card (controller, component, locales, registration)

**Files:**
- Modify: `plugin/src/client/index.ts` (replace the placeholder)
- Create: `plugin/src/client/locales.ts`, `plugin/src/client/eval-card-controller.ts`, `plugin/src/client/EvalCard.tsx`
- Test: `plugin/tests/eval-card.test.ts`

**Interfaces:**
- Consumes: `ctx.configForms.get('canness-eval')` (the shared form for the `canness-eval` Loader entry id), `ctx.remote.credentials.describe/set` (`RemoteResult` shape: `{ ok: true, value } | { ok: false, error }`), the `settings.section` list slot (`{ kind: 'list', scope: 'root' }`, options `id`/`order`/`label`/`locale`/`inject`), and dsh primitives: `SettingsForm`, `SettingsValueField`, `SettingsSecretField`, `Switch`, `SettingsFormModel`, `settingsTextField`, `settingsNumberField`.
- Produces: `EvalCardController` (exported for the test), `EVAL_NS = 'canness-eval'`, card state/face types, and the registered Settings nav entry id `'canness'`.

- [ ] **Step 1: Write the failing test**

`plugin/tests/eval-card.test.ts` (new). Note on `save`: `SettingsFormActions.save` is fire-and-forget (`void`), so the tests wait on observable outcomes — `mutate` resolutions and the post-write `describe` — through a short async poll helper rather than awaiting `face.save()` itself.

```ts
import { expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { EvalCardController, EVAL_NS, type EvalSettings } from '../src/client/eval-card-controller.ts'
import type { SettingsFormPathOp, SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'

/** Resolve once a save settles: a scope mutation or a credentials call ran. */
async function settled(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the card to settle')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function fakeScope(section?: EvalSettings) {
  const listeners = new Set<() => void>()
  const opsApplied: SettingsFormPathOp[] = []
  let revision = 0
  const scope: SettingsFormScope<EvalSettings> = {
    getSnapshot: () => ({
      status: section === undefined ? 'unavailable' : 'ready',
      value: section,
      base: {},
      user: {},
      writable: true,
      revision,
    }),
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    mutate: async (ops) => { revision += 1; opsApplied.push(...ops); return true },
  }
  return { scope, opsApplied, notify: () => { for (const fn of listeners) fn() } }
}

function fakeCtx(store: { configuredRef?: string }) {
  const calls: { op: 'describe' | 'set'; ref?: string; value?: string }[] = []
  const ctx = {
    remote: {
      credentials: {
        describe: async (refs: string[]) => {
          calls.push({ op: 'describe' })
          return { ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: store.configuredRef === ref, writable: true }])) }
        },
        set: async (ref: string, value: string) => {
          calls.push({ op: 'set', ref, value })
          store.configuredRef = ref
          return { ok: true, value: undefined }
        },
      },
    },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const section: EvalSettings = {
  host: 'npu', port: 22, username: 'canness', privateKeyPath: '', inbox: '/in', outbox: '/out',
}

test('saving writes section fields through mutate and the password through credentials', async () => {
  const scope = fakeScope(section)
  const store: { configuredRef?: string } = {}
  const remote = fakeCtx(store)
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('host', 'npu2')
  face.edit('password', 'secret-pw')
  face.save()
  await settled(() => scope.opsApplied.length === 1 && remote.calls.some(call => call.op === 'set'))
  expect(scope.opsApplied).toEqual([{ op: 'set', path: ['host'], value: 'npu2' }])
  const setCall = remote.calls.find(call => call.op === 'set')
  expect(setCall).toMatchObject({ ref: 'CANNNESS_SSH_PASSWORD', value: 'secret-pw' })
  await settled(() => face.hooks.evalCard.getSnapshot().passwordConfigured === true)
  expect(face.hooks.evalCard.getSnapshot().passwordConfigured).toBe(true)
  card.dispose()
})

test('a blank password draft writes nothing and keeps the section mutation alone', async () => {
  const scope = fakeScope(section)
  const remote = fakeCtx({ configuredRef: 'CANNNESS_SSH_PASSWORD' })
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('host', 'npu2')
  face.save()
  await settled(() => scope.opsApplied.length === 1)
  expect(scope.opsApplied).toEqual([{ op: 'set', path: ['host'], value: 'npu2' }])
  expect(remote.calls.some(call => call.op === 'set')).toBe(false)
  card.dispose()
})

test('the auth mode derives from the key path and can be overridden', () => {
  const scope = fakeScope({ ...section, privateKeyPath: '/home/me/.ssh/id_rsa' })
  const remote = fakeCtx({})
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  expect(face.hooks.evalCard.getSnapshot().usePassword).toBe(false)
  face.setUsePassword(true)
  expect(face.hooks.evalCard.getSnapshot().usePassword).toBe(true)
  card.dispose()
})

test('passwordEnv in the section names the credential reference', async () => {
  const scope = fakeScope({ ...section, passwordEnv: 'CUSTOM_SSH_REF' })
  const remote = fakeCtx({})
  const card = new EvalCardController(remote.ctx, scope.scope)
  const face = card.inject()
  face.edit('password', 'pw')
  face.save()
  await settled(() => remote.calls.some(call => call.op === 'set'))
  expect(remote.calls.find(call => call.op === 'set')).toMatchObject({ ref: 'CUSTOM_SSH_REF' })
  card.dispose()
})

test('EVAL_NS is the canness-eval entry id', () => {
  expect(EVAL_NS).toBe('canness-eval')
})
```

(`face.hooks.evalCard` is the injected store — the renderer turns it into the `useEvalCard` prop for the component, but the raw face keeps `hooks`.)

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd plugin && pnpm vitest run tests/eval-card.test.ts`
Expected: FAIL — `../src/client/eval-card-controller.ts` does not exist.

- [ ] **Step 3: Implement the controller**

`plugin/src/client/eval-card-controller.ts`:

```ts
/**
 * The CANNESS settings card's staged form over the `canness-eval` entry:
 * remote-host fields save through the settings form (path ops into the
 * profile patch), while the SSH password is written through the credentials
 * domain, so its literal never rides a settings response. The auth mode
 * switch is presentational: it only chooses which credential field the card
 * shows, and the Host-side priority (private key first) is unchanged.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** Profile entry id the card edits; the Host plugin row id in cordis.patch.yml. */
export const EVAL_NS = 'canness-eval'

/** Credential reference the password control addresses when the section names none. */
const DEFAULT_PASSWORD_REF = 'CANNNESS_SSH_PASSWORD'

/** Form field the credential control stages under. */
const PASSWORD_FIELD = 'password'

/** The canness-eval fields this card edits. */
export interface EvalSettings {
  host?: string
  port?: number
  username?: string
  privateKeyPath?: string
  passwordEnv?: string
  inbox?: string
  outbox?: string
  timeoutSec?: number
  pollIntervalMs?: number
  maxIterations?: number
  maxCompileRetries?: number
  negativeStreakLimit?: number
  convergenceThreshold?: number
}

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
}

/** What the CANNESS card renders. */
export interface EvalCardState extends SettingsFormShell {
  host: SettingsFieldState
  port: SettingsFieldState
  username: SettingsFieldState
  privateKeyPath: SettingsFieldState
  inbox: SettingsFieldState
  outbox: SettingsFieldState
  timeoutSec: SettingsFieldState
  pollIntervalMs: SettingsFieldState
  maxIterations: SettingsFieldState
  maxCompileRetries: SettingsFieldState
  negativeStreakLimit: SettingsFieldState
  convergenceThreshold: SettingsFieldState
  /** The staged password draft; blank on every load and never echoed back. */
  password: SettingsFieldState
  /** Whether the credentials domain reports a password for the referenced key. */
  passwordConfigured: boolean
  /** Whether the credentials domain accepts a write; false disables the control. */
  passwordWritable: boolean
  /** Presentational auth mode: true shows the password field, false the key path. */
  usePassword: boolean
}

/** The registration-side face the card's slot entry injects. */
export interface EvalCardFace extends SettingsFormActions {
  hooks: {
    /** Card snapshot bound by the renderer as useEvalCard. */
    evalCard: SnapshotStore<EvalCardState>
  }
  /** Switch the credential field the card shows; stages nothing. */
  setUsePassword: (enabled: boolean) => void
}

/** Bridges the canness-eval settings form and the credentials domain onto the card. */
export class EvalCardController {
  private readonly form: SettingsFormModel<EvalSettings>
  private readonly store: SnapshotStore<EvalCardState>
  private readonly unsubscribeScope: () => void
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private modeOverride: boolean | undefined

  /**
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the password the section references.
   * @param scope - the shared configuration form for the canness-eval entry.
   */
  constructor(
    private readonly ctx: ClientContext,
    private readonly scope: SettingsFormScope<EvalSettings>,
  ) {
    this.form = new SettingsFormModel(scope, [
      settingsTextField('host'),
      settingsNumberField('port'),
      settingsTextField('username'),
      settingsTextField('privateKeyPath'),
      settingsTextField('inbox'),
      settingsTextField('outbox'),
      settingsNumberField('timeoutSec'),
      settingsNumberField('pollIntervalMs'),
      settingsNumberField('maxIterations'),
      settingsNumberField('maxCompileRetries'),
      settingsNumberField('negativeStreakLimit'),
      settingsNumberField('convergenceThreshold'),
    ], [{ field: PASSWORD_FIELD, write: text => this.writePassword(text) }])
    this.store = this.form.bind(() => this.projection())
    this.unsubscribeScope = scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  /** The reference the section names, or the default. */
  private ref(): string {
    const declared = this.scope.getSnapshot().value?.passwordEnv
    return declared !== undefined && declared.length > 0 ? declared : DEFAULT_PASSWORD_REF
  }

  private async readCredential(): Promise<void> {
    const ref = this.ref()
    if (ref !== this.credential.ref) {
      this.credential = { ref, configured: false, writable: true }
      this.store.set(this.projection())
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== this.ref()) return
    const view = response.value[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference stays writable: the Host refuses, not the card.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.credential.configured && next.writable === this.credential.writable) return
    this.credential = next
    this.store.set(this.projection())
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches;
   * a password written on another surface must refresh the badge.
   * @param ref - the reference the Host reports as changed.
   */
  refreshCredential(ref: string): void {
    if (ref !== this.credential.ref) return
    void this.readCredential()
  }

  private async writePassword(value: string): Promise<boolean> {
    // Refusals surface through the re-read: the Host is the only authority.
    await this.ctx.remote.credentials.set(this.ref(), value)
    await this.readCredential()
    return this.credential.configured
  }

  private projection(): EvalCardState {
    return {
      ...this.form.shell(),
      host: this.form.field('host'),
      port: this.form.field('port'),
      username: this.form.field('username'),
      privateKeyPath: this.form.field('privateKeyPath'),
      inbox: this.form.field('inbox'),
      outbox: this.form.field('outbox'),
      timeoutSec: this.form.field('timeoutSec'),
      pollIntervalMs: this.form.field('pollIntervalMs'),
      maxIterations: this.form.field('maxIterations'),
      maxCompileRetries: this.form.field('maxCompileRetries'),
      negativeStreakLimit: this.form.field('negativeStreakLimit'),
      convergenceThreshold: this.form.field('convergenceThreshold'),
      password: this.form.field(PASSWORD_FIELD),
      passwordConfigured: this.credential.configured,
      passwordWritable: this.credential.writable,
      usePassword: this.modeOverride ?? this.form.field('privateKeyPath').text.trim() === '',
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its form actions, and the auth-mode switch.
   */
  inject(): EvalCardFace {
    const actions = this.form.actions()
    return {
      hooks: { evalCard: this.store },
      ...actions,
      discard: () => {
        this.modeOverride = undefined
        actions.discard()
      },
      setUsePassword: (enabled) => {
        this.modeOverride = enabled
        this.store.set(this.projection())
      },
    }
  }

  /** Release the form and scope subscriptions. */
  dispose(): void {
    this.unsubscribeScope()
    this.form.dispose()
  }
}
```

- [ ] **Step 4: Implement the locales**

`plugin/src/client/locales.ts`:

```ts
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
```

- [ ] **Step 5: Implement the component**

`plugin/src/client/EvalCard.tsx`:

```tsx
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
```

- [ ] **Step 6: Implement the browser-half entry**

Replace `plugin/src/client/index.ts`:

```ts
/**
 * CANNESS browser half: the Settings-panel card for the canness-eval entry.
 * The card registers into `settings.section` while the Host serves the
 * canness-eval namespace, so a deployment without the plugin shows no trace
 * of it. The password control writes through the credentials domain; every
 * other field saves through the shared settings form into the profile patch.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms merge and the settings slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.slots merge (SlotRegistry).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { EvalCard } from './EvalCard.tsx'
import { EvalCardController, EVAL_NS } from './eval-card-controller.ts'
import { en, zh, type CannessSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** CANNESS settings card copy. */
    'settings.canness': CannessSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.canness'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** Mount the CANNESS settings card while the Host serves the canness-eval namespace. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'canness-client: dictionaries')
  const card = new EvalCardController(ctx, ctx.configForms.get(EVAL_NS))
  ctx.effect(() => () => { card.dispose() }, 'canness-client: form subscription')
  // The credential the card reports is not part of any settings section, so
  // this is the only signal that a password written elsewhere reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    'canness-client: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([EVAL_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'canness',
    order: 50,
    label: () => t('nav'),
    locale: NS,
    inject: () => card.inject(),
  }, EvalCard))), 'canness-client: settings section')
}
```

- [ ] **Step 7: Run the tests, type check, and build**

Run: `cd plugin && pnpm test && pnpm run check && pnpm build`
Expected: all tests PASS (including the new controller tests), both tsc configs exit 0, `lib/client.js` builds. If `tsc -p tsconfig.client.json` reports prop mismatches on the `ctx.slots.register` call or `EvalCardProps`, fix the component/face types to satisfy the composed-props contract — do not silence it with casts.

- [ ] **Step 8: Commit**

```bash
git add plugin/src/client plugin/tests/eval-card.test.ts
git commit -m "feat: add the canness settings card"
```

---

### Task 5: README and full regression

**Files:**
- Modify: `plugin/README.md`
- Test: the commands below

**Interfaces:**
- Consumes: everything above.
- Produces: documentation for password auth + the settings card, and a green full check.

- [ ] **Step 1: Update `plugin/README.md`**

Keep the existing three sections; after section 2 (install) add a section on credentials, and note the settings card. New content to weave in (Chinese, matching the file's existing tone):

```markdown
## 3. 认证：私钥或密码

`run_evaluation` 按以下优先级认证：配置了 `privateKeyPath` 时使用私钥；否则从 dsh 凭据存储解析 `passwordEnv`（默认 `CANNNESS_SSH_PASSWORD`）作为密码；两者都没有时报 `ssh credentials missing`。

存密码（二选一）：

- Web UI：打开设置 → CANNESS 卡片，填入 SSH 密码后保存。密码进入 `~/.dsh/.credentials.yaml`，不写入任何配置文件。
- 命令行环境：`CANNNESS_SSH_PASSWORD=... dsh --profile canness`（环境变量是凭据存储的回退层）。
```

Renumber the existing "3. 远端" to "4." and add to it a line noting the watch.py flow is unchanged. Also update section 2's dump-config paragraph: the `canness-eval` 段的字段（host、username、privateKeyPath、inbox、outbox、超时与迭代参数）现在都可以在 Web 设置卡里改，改完直接保存在 profile 的 `cordis.patch.yml`，无需重启。

- [ ] **Step 2: Full regression**

Run:
```bash
cd plugin && pnpm test && pnpm run check && pnpm build
```
Expected: all tests PASS (37 existing + the new password/auth, scaffold, and card tests), both tsc configs exit 0, `lib/index.js` and `lib/client.js` produced.

- [ ] **Step 3: Commit**

```bash
git add plugin/README.md
git commit -m "docs: describe the password auth and the settings card"
```

- [ ] **Step 4: Manual acceptance (only with dsh and a host) — not blocking**

```bash
dsh plugin --profile canness add ./plugin
dsh --profile canness --dump-config
```

Then in the web profile: Settings → CANNESS → fill host/port/username, switch to 密码认证, enter the SSH password, save; verify `~/.dsh/.credentials.yaml` gains `CANNNESS_SSH_PASSWORD` and the profile's `cordis.patch.yml` gains the canness-eval fields; then a headless `run_evaluation` connects with the password. With only the mock remote available, expect the report's `analysis.source` to be `msprof-mock` as before.
