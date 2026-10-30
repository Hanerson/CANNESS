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
