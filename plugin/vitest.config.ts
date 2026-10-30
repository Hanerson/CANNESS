import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))
const emptyCssStub = path.resolve(root, 'tests/stubs/empty.css.js')
const clientStoreStub = path.resolve(root, 'tests/stubs/client-store.js')
const HOST_STUB_ID = '\0canness-host-stub'

/**
 * Host-workspace packages the published primitives barrel value-imports.
 * Stubbed only for vitest so SettingsFormModel can load without installing them.
 */
const HOST_PACKAGE_IDS = [
  'clsx',
  'react-dom',
  'shiki',
  '@shikijs/langs',
  'katex',
  'simple-icons',
  'anser',
  'diff',
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-symbol',
  'micromark-util-types',
  'micromark-factory-space',
  'micromark-util-sanitize-uri',
  'micromark-extension-gfm',
  'micromark-extension-math',
  '@deepseek-ai/dsh-util-workspace-path',
  '@deepseek-ai/dsh-util-code-language',
]

function isHostPackage(id: string): boolean {
  return HOST_PACKAGE_IDS.some(pkg => id === pkg || id.startsWith(`${pkg}/`))
}

function rewriteNamedImport(imported: string, stubId: string): string {
  const [exported, alias] = imported.split(/\s+as\s+/).map(part => part.trim())
  return `const ${alias ?? exported} = ${stubId}`
}

/** Rewrite host-only npm ids and CSS before Vite's default resolvers. */
function stubHostImports(): Plugin {
  let stubSeq = 0
  return {
    name: 'canness-stub-host-imports',
    enforce: 'pre',
    resolveId(id) {
      // Real store JS imports zustand/immer, which the published tarball does not ship.
      if (id === '@deepseek-ai/dsh-client-store') return clientStoreStub
      if (id === HOST_STUB_ID || id === '/@id/canness-host-stub') return HOST_STUB_ID
      if (isHostPackage(id)) return HOST_STUB_ID
      if (id.endsWith('.css')) return emptyCssStub
    },
    load(id) {
      const file = id.split('?')[0] ?? id
      if (file.replace(/\\/g, '/').endsWith('/dsh-client-ui-primitives/lib/index.js')) {
        return readFileSync(file, 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '')
      }
      if (id !== HOST_STUB_ID) return
      return `
const stub = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === '__esModule') return true
    if (prop === 'then') return undefined
    if (prop === 'default') return stub
    if (prop === Symbol.toPrimitive) return (hint) => hint === 'number' ? 0 : ''
    if (prop === 'valueOf') return () => 0
    if (prop === 'toString') return () => ''
    if (prop === Symbol.toStringTag) return 'CannessHostStub'
    return stub
  },
  apply() { return stub },
  construct() { return stub },
})
export default stub
`
    },
    transform(code, id) {
      if (!id.replace(/\\/g, '/').includes('/dsh-client-ui-primitives/')) return
      const next = code.replace(
        /import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\}|([A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']\s*;?/g,
        (match, mixedDefault: string | undefined, namespace: string | undefined, named: string | undefined, defaultName: string | undefined, source: string) => {
          if (!isHostPackage(source)) return match
          const stubId = `__cannessHostStub${stubSeq++}`
          const header = `import ${stubId} from ${JSON.stringify(HOST_STUB_ID)};`
          if (namespace) return `${header} const ${namespace} = ${stubId}`
          const bindings: string[] = []
          const localDefault = mixedDefault ?? defaultName
          if (localDefault) bindings.push(`const ${localDefault} = ${stubId}`)
          if (named) {
            for (const spec of named.split(',')) {
              const imported = spec.trim()
              if (imported.length > 0) bindings.push(rewriteNamedImport(imported, stubId))
            }
          }
          return `${header} ${bindings.join('; ')}`
        },
      )
      const stripped = next.replace(/\/\/# sourceMappingURL=.*$/m, '')
      return stripped === code ? undefined : stripped
    },
  }
}

export default defineConfig({
  plugins: [stubHostImports()],
  test: {
    include: ['tests/**/*.test.ts'],
    // Vite must transform the primitives barrel so stubs bind its host imports.
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
