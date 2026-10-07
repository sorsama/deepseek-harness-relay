/**
 * Packing a tree whose `lib/` is stale must not ship the stale runtime.
 *
 * `prepare` deliberately skips a checkout whose bundles already exist, so an
 * install never builds them twice. A publish from such a tree therefore packs
 * whatever `lib/` happened to hold — which is how the 0.2.1 npm tarball went
 * out with fresh declarations beside a runtime that predates the
 * harness-session change, and every request it proxied to a harness 0.1.2 or
 * later was answered 401. `prepack` owns the rebuild now; this guard poisons
 * the runtime, packs, and reads the bytes inside the tarball to prove it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const runtimePath = join(root, 'lib', 'index.js')
const POISON = '// dsh-relay: stale runtime sentinel\n'
const REQUIRED = 'dsh-auth-'

const original = existsSync(runtimePath) ? readFileSync(runtimePath) : undefined
const scratch = mkdtempSync(join(root, '.pack-check-'))

try {
  writeFileSync(runtimePath, POISON)
  const pack = spawnSync(`pnpm pack --pack-destination "${scratch}"`, {
    cwd: root,
    encoding: 'utf8',
    shell: true,
  })
  if (pack.status !== 0) {
    process.stderr.write(pack.stderr ?? '')
    process.exitCode = 1
  } else {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const tarball = join(scratch, `${manifest.name}-${manifest.version}.tgz`)
    const extracted = spawnSync('tar', ['-xOf', tarball, 'package/lib/index.js'], { encoding: 'buffer' })
    if (extracted.status !== 0) {
      process.stderr.write(String(extracted.stderr ?? 'tar could not read the tarball'))
      process.exitCode = 1
    } else if (extracted.stdout.includes(POISON) || !extracted.stdout.includes(REQUIRED)) {
      console.error('dsh-relay: packing shipped a stale runtime; the prepack build is missing or skipped')
      process.exitCode = 1
    } else {
      console.log('dsh-relay: packing rebuilt the runtime')
    }
  }
} finally {
  if (original === undefined) rmSync(runtimePath, { force: true })
  else writeFileSync(runtimePath, original)
  rmSync(scratch, { recursive: true, force: true })
}
