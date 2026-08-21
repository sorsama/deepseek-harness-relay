/**
 * Post-install build for source installs.
 *
 * `dsh plugin add github:sorsama/deepseek-harness-relay` fetches sources, not
 * `lib/`, and nothing else runs a build there — so this script produces both
 * halves on its own, with no monorepo, no project references, and no
 * typecheck. A registry or tarball install already ships `lib/` and skips.
 *
 * It also fails soft, which matters more than it looks. A package that
 * declares `dsh.client` and has no `lib/client.js` makes the harness's
 * ClientModuleRegistry throw, and that failure is fatal to the entire boot:
 * `dsh web` exits and serves no web UI at all, loopback included. So if the
 * browser half does not build, this withdraws the `dsh.client` declaration
 * from the installed manifest. The operator loses the settings card and keeps
 * a working harness, which is the right way round.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const clientBundle = new URL('../lib/client.js', import.meta.url)
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

if (existsSync(new URL('../lib/index.js', import.meta.url)) && existsSync(clientBundle)) {
  console.log('dsh-relay: lib/ already built, skipping prepare')
  process.exit(0)
}

const built = spawnSync('tsdown', [], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DSH_RELAY_FROM_SOURCE: '1' },
})

if (existsSync(clientBundle)) process.exit(built.status ?? 0)

// No browser bundle. Withdraw the declaration rather than hand the harness a
// package it will refuse to boot with.
try {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.client !== undefined) {
    delete manifest.dsh.client
    delete manifest.exports?.['./client']
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.warn(
      'dsh-relay: the browser half did not build, so the settings card is disabled for this install. '
      + 'The relay itself is unaffected; its pages are at /relay/devices.',
    )
  }
} catch (error) {
  console.warn(`dsh-relay: could not withdraw the client declaration: ${String(error)}`)
}

// The node half is what matters; a failed client build is not fatal.
process.exit(existsSync(new URL('../lib/index.js', import.meta.url)) ? 0 : (built.status ?? 1))
