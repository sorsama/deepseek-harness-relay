/**
 * Build config for the plugin's node half.
 *
 * v1 ships no browser half on purpose. A `dsh.client` declaration whose
 * `lib/client.js` is missing makes the harness's ClientModuleRegistry throw,
 * and that failure takes down `/plugins` and the SPA for every client
 * including loopback — which is exactly what a `dsh plugin add github:...`
 * install produces when its build script was not allowlisted. The relay's
 * admin surface is its own `/relay/*` pages instead.
 *
 * `DSH_RELAY_FROM_SOURCE=1` builds straight from `src/` with no prior `tsc`
 * pass, which is how `scripts/prepare.mjs` makes a source install self-build
 * without project references or a typecheck.
 */
import type { UserConfig } from 'tsdown'

/** Production dependencies stay imports; everything else is inlined. */
const EXTERNALS = [
  /^bonjour-service(\/|$)/,
  /^qrcode(\/|$)/,
  /^selfsigned(\/|$)/,
  /^@deepseek-ai\//,
]

const fromSource = process.env.DSH_RELAY_FROM_SOURCE === '1'
const isExternal = (specifier: string): boolean => EXTERNALS.some(pattern => pattern.test(specifier))

const config: UserConfig = {
  name: 'dsh-relay',
  entry: fromSource
    ? ['src/index.ts']
    : ['lib/types/index.js'],
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

export default config
