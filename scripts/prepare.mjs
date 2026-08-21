/**
 * Post-install build for source installs.
 *
 * `dsh plugin add github:sorsama/deepseek-harness-relay` fetches sources, not
 * `lib/`, and nothing else runs a build there — so this script has to produce
 * both halves on its own, with no monorepo, no project references, and no
 * typecheck. A tarball or registry install already ships `lib/` and skips.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (existsSync(new URL('../lib/client.js', import.meta.url))) {
  console.log('dsh-relay: lib/ already built, skipping prepare')
  process.exit(0)
}

const result = spawnSync('tsdown', [], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DSH_RELAY_FROM_SOURCE: '1' },
})

process.exit(result.status ?? 1)
