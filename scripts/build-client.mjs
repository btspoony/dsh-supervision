/**
 * Client bundle build: emits the closure-factory CJS artifact the dsh web
 * loader consumes —
 * `window.__ModuleLoader__.load({ id: 'dsh-supervision', factory: (require) => { … } })`.
 *
 * Runs after the host `tsdown` pass (that config has `clean: true`), so this
 * script builds with `config: false` and `clean: false`. React and its runtime
 * stay external — the loader table answers them — and everything else inlines,
 * because the browser cannot resolve a specifier the loader does not know.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'tsdown'

const ID = 'dsh-supervision'
const ENTRY = 'src/client/index.ts'
const OUT_DIR = 'lib/client'
const OUT_FILE = 'index.js'
const BANNER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`

/** The loader module table: the only `require()`s the browser can answer. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis']

await build({
  // Standalone: never merge tsdown.config.ts, which owns the host bundle.
  config: false,
  name: `${ID}/client`,
  entry: { index: ENTRY },
  outDir: OUT_DIR,
  format: 'cjs',
  // CJS always defaults to node; the loader runs this in the browser.
  inputOptions: { platform: 'browser' },
  target: 'es2022',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    onlyBundle: false,
  },
  // React reads process.env.NODE_ENV at module scope; the artifact is a release build.
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  outputOptions: {
    entryFileNames: OUT_FILE,
    banner: BANNER,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})

const outFile = join(OUT_DIR, OUT_FILE)
if (!existsSync(outFile)) {
  throw new Error(`build-client: expected ${outFile} — check entry/outDir/entryFileNames`)
}

const bundleText = readFileSync(outFile, 'utf8')
// The bundler reflows the banner across lines, so the check compares the
// collapsed head: same tokens, same order, no reliance on the printer's layout.
const collapsed = (text) => text.replace(/\s+/g, ' ').trim()
if (!collapsed(bundleText).startsWith(collapsed(BANNER))) {
  throw new Error(`build-client: ${outFile} does not start with the loader banner — the loader would never register this plugin`)
}
// Externals are the only legitimate `require()` targets; any other DSH package
// reaching the artifact means a value import that had to be bundled.
const strays = [...bundleText.matchAll(/require\("(@deepseek-ai\/dsh-[\w./-]+)"\)/g)]
  .map(match => match[1])
  .filter(specifier => !CLIENT_EXTERNALS.includes(specifier))
if (strays.length > 0) {
  throw new Error(`build-client: non-external DSH require(s) survived in ${outFile}: ${strays.join(', ')}`)
}

console.log(`build-client: ${ENTRY} -> ${outFile} (${String(statSync(outFile).size)} bytes, closure-factory CJS)`)
