/**
 * The peer ranges are the plugin's admission ticket.
 *
 * DSH reads them before a profile starts and refuses a plugin whose ranges do
 * not admit the running harness. That refusal is not a warning: the plugin
 * stays installed and never mounts, so the relay binds no port and the operator
 * sees a dead plugin rather than a version mismatch.
 *
 * The 0.3.0 ranges stopped at `<0.2.1-0`, which excluded 0.2.1-rc.2 even though
 * every harness surface this plugin uses was unchanged. This pins the two
 * directions that matter: the generations the build was verified on are
 * admitted, and the next untested minor is not.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

interface Manifest {
  readonly peerDependencies: Readonly<Record<string, string>>
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Manifest

/** The harness packages whose ranges the startup check evaluates. */
const HARNESS_PEERS = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
] as const

/** Harness releases this build has been measured against. */
const VERIFIED = [
  '0.1.7-rc.2',
  '0.1.8',
  '0.2.0-rc.1',
  '0.2.0',
  '0.2.1-alpha.1',
  '0.2.1-rc.2',
  '0.2.1',
] as const

/** Releases the ranges must keep out, so an untested minor cannot install silently. */
const REFUSED = ['0.1.6', '0.2.2-0', '0.3.0'] as const

describe('declared harness compatibility', () => {
  it('declares a range for every harness package the plugin binds to', () => {
    for (const pkg of HARNESS_PEERS) {
      expect(manifest.peerDependencies[pkg], `${pkg} must declare a peer range`).toBeTypeOf('string')
    }
  })

  it('admits every harness generation this build was verified on', () => {
    for (const pkg of HARNESS_PEERS) {
      const range = manifest.peerDependencies[pkg]
      for (const version of VERIFIED) {
        expect(satisfies(version, range!, { includePrerelease: true }), `${pkg} ${range} must admit ${version}`).toBe(true)
      }
    }
  })

  it('refuses the next untested generation', () => {
    for (const pkg of HARNESS_PEERS) {
      const range = manifest.peerDependencies[pkg]
      for (const version of REFUSED) {
        expect(satisfies(version, range!, { includePrerelease: true }), `${pkg} ${range} must refuse ${version}`).toBe(false)
      }
    }
  })

  it('admits the cordis version the 0.2.1 harness ships', () => {
    const range = manifest.peerDependencies['@deepseek-ai/cordis']
    expect(range, 'cordis must declare a peer range').toBeTypeOf('string')
    expect(satisfies('4.0.5', range!, { includePrerelease: true }), `cordis ${range} must admit 4.0.5`).toBe(true)
  })
})
