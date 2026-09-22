/**
 * Post-install build for source installs.
 *
 * `dsh plugin add github:sorsama/deepseek-harness-relay` fetches sources, not
 * `lib/`, and nothing else runs a build there — so this script produces both
 * halves on its own, with no monorepo, no project references, and no
 * typecheck. A registry or tarball install already ships `lib/` and skips.
 *
 * "Already ships `lib/`" is judged by freshness, not by existence. npm runs
 * this script during `npm publish` too, and the existence-only check it used
 * to make meant a checkout whose `lib/` predated a source change published the
 * older bundle under the new version. That is how 0.2.1 reached the registry
 * without `src/harness-session.ts` in it: the relay paired devices and then
 * had no session of its own to present upstream, so the harness refused every
 * proxied request with 401. One directory walk removes the whole failure mode.
 *
 * It also fails soft, which matters more than it looks. A package that
 * declares `dsh.client` and has no `lib/client.js` makes the harness's
 * ClientModuleRegistry throw, and that failure is fatal to the entire boot:
 * `dsh web` exits and serves no web UI at all, loopback included. So if the
 * browser half does not build, this withdraws the `dsh.client` declaration
 * from the installed manifest. The operator loses the settings card and keeps
 * a working harness, which is the right way round.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const indexBundle = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const clientBundle = new URL('../lib/client.js', import.meta.url)
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))

/** Newest modification time under a directory, in milliseconds. */
function newestMtime(path) {
  let newest = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = fileURLToPath(new URL(entry.name + (entry.isDirectory() ? '/' : ''), `file://${path}/`))
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(child) : statSync(child).mtimeMs)
  }
  return newest
}

/** Whether the shipped bundles are at least as new as everything they are built from. */
function bundlesAreCurrent() {
  if (!existsSync(indexBundle) || !existsSync(clientBundle)) return false
  const built = Math.min(statSync(indexBundle).mtimeMs,
                         statSync(fileURLToPath(clientBundle)).mtimeMs)
  const sources = Math.max(newestMtime(fileURLToPath(new URL('../src', import.meta.url))),
                           statSync(manifestPath).mtimeMs,
                           statSync(fileURLToPath(new URL('../tsdown.config.ts', import.meta.url))).mtimeMs)
  return built >= sources
}

if (bundlesAreCurrent()) {
  console.log('dsh-relay: lib/ is newer than src/, skipping prepare')
  process.exit(0)
}

console.log('dsh-relay: lib/ is missing or older than src/, building')

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
