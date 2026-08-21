/**
 * Build config for both halves of the plugin.
 *
 * The node half is an ordinary ESM library. The browser half must reproduce
 * the harness's client-plugin artifact exactly: the web shell fetches
 * `lib/client.js` outside any module graph and expects a closure factory that
 * registers itself with `window.__ModuleLoader__`, resolving its externals
 * through the injected `require`. The in-repo preset that emits this is not
 * published, so the contract is restated here.
 *
 * Getting it wrong is expensive. A `dsh.client` declaration whose bundle is
 * missing makes ClientModuleRegistry throw, and that failure is fatal to the
 * whole boot — `dsh web` exits and serves no web UI at all, loopback included.
 * `scripts/prepare.mjs` therefore withdraws the declaration rather than let a
 * failed client build take the harness down with it.
 *
 * `DSH_RELAY_FROM_SOURCE=1` builds straight from `src/` with no prior `tsc`
 * pass, which is how `scripts/prepare.mjs` makes a source install self-build
 * without project references or a typecheck.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Package name, stamped into the loader handoff and onto injected style tags. */
const ID = 'dsh-relay'

/** Production dependencies stay imports in the node half; everything else inlines. */
const EXTERNALS = [
  /^bonjour-service(\/|$)/,
  /^qrcode(\/|$)/,
  /^selfsigned(\/|$)/,
  /^@deepseek-ai\//,
]

/**
 * Specifiers the web shell shares into its frozen module table. A client
 * bundle must leave these as `require()` calls and inline everything else: a
 * request the table cannot answer throws inside the factory at boot.
 * Mirrors `packages/client/web/src/platform.ts`.
 */
const MODULE_TABLE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

/** Virtual id keeping module CSS out of tsdown's own stylesheet pipeline. */
const CSS_PREFIX = '\0dsh-relay-css:'
const CSS_SUFFIX = '.mjs'

const fromSource = process.env.DSH_RELAY_FROM_SOURCE === '1'
const isExternal = (specifier: string): boolean => EXTERNALS.some(pattern => pattern.test(specifier))

/**
 * Locate a stylesheet against the sources, whether the importer is a source
 * file or the JavaScript tsc emitted from it.
 * @param source - the relative specifier as written.
 * @param importer - absolute path of the importing module.
 * @returns the stylesheet's absolute path.
 */
function stylesheetPath(source: string, importer: string): string {
  const direct = resolvePath(dirname(importer), source)
  if (existsSync(direct)) return direct
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = direct.indexOf(marker)
  if (boundary < 0) return direct
  return resolvePath(direct.slice(0, boundary), 'src', direct.slice(boundary + marker.length))
}

const nodeConfig: UserConfig = {
  name: ID,
  entry: fromSource ? ['src/index.ts'] : ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: isExternal,
    alwaysBundle: (specifier: string) => !isExternal(specifier),
  },
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: fromSource ? 'src/client/index.ts' : 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  // `external` rather than the `deps` predicates: the shell resolves these
  // through its own module table, and a second copy of React inlined here
  // would give the card its own hook dispatcher and break on first render.
  external: [...MODULE_TABLE],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // A require() the module table cannot answer is a guaranteed throw inside
    // the factory, so an undeclared @deepseek-ai import fails the build here.
    name: 'dsh-relay-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (MODULE_TABLE.has(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a module-table row — `
        + 'collaborate through cordis services, or import it type-only.',
      )
    },
  }, {
    // CSS Modules compile inside the bundle and inject a plugin-tagged style
    // element when the factory runs, as the harness's own preset does.
    name: 'dsh-relay-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined ? source : stylesheetPath(source, importer)
      return `${CSS_PREFIX}${file}${CSS_SUFFIX}`
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null
      const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      const { code, exports: cssExports } = transform({
        filename: file,
        code: await readFile(file),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exported] of Object.entries(cssExports ?? {})) classMap[local] = exported.name
      const tagId = `${ID}/${basename(file)}`
      const lines = [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ]
      return lines.join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeConfig, clientConfig]
