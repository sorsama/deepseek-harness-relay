/**
 * The declared harness range is the plugin's admission ticket.
 *
 * Before a profile starts, the harness compares a plugin's `engines.dsh` — or,
 * without one, every `@deepseek-ai/dsh-*` peer range — against its own
 * version, and refuses a plugin they do not admit. That refusal is not a
 * warning: the plugin stays installed and never mounts, so the relay binds no
 * port and the operator sees a dead plugin rather than a version mismatch.
 *
 * So the range must admit every release this build supports, and must keep
 * out the ones it cannot run on: a harness before 0.1.7 has none of the
 * settings plane the browser half binds to, and the next minor is untested.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'
import { describe, expect, it } from 'vitest'

interface Manifest {
  readonly engines: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly dsh: { readonly client: { readonly inject: readonly string[] } }
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as Manifest

/** The harness packages the plugin binds to, one half or the other. */
const HARNESS_PEERS = [
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-settings',
] as const

/** Harness releases this build supports, measured or audited. */
const ADMITTED = [
  '0.1.7-rc.2',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
  '0.2.1-alpha.1',
  '0.2.1-rc.2',
  '0.2.1-rc.3',
  '0.2.1',
  '0.2.2',
] as const

/** Releases the range must keep out. */
const REFUSED = ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.1', '0.3.0-alpha.1', '0.3.0'] as const

/** Every range the harness may evaluate: `engines.dsh`, and the peers it falls back to. */
function ranges(): [string, string][] {
  return [
    ['engines.dsh', manifest.engines.dsh ?? ''],
    ...HARNESS_PEERS.map((pkg): [string, string] => [pkg, manifest.peerDependencies[pkg] ?? '']),
  ]
}

describe('declared harness compatibility', () => {
  it('declares engines.dsh and a range for every harness package the plugin binds to', () => {
    expect(manifest.engines.dsh, 'engines.dsh decides admission on its own').toBeTypeOf('string')
    for (const pkg of HARNESS_PEERS) {
      expect(manifest.peerDependencies[pkg], `${pkg} must declare a peer range`).toBeTypeOf('string')
    }
  })

  it('states one range everywhere, so no harness reads a different answer', () => {
    const distinct = new Set(ranges().map(([, range]) => range))
    expect([...distinct]).toEqual([manifest.engines.dsh])
  })

  it('admits every supported harness release', () => {
    for (const [where, range] of ranges()) {
      for (const version of ADMITTED) {
        expect(satisfies(version, range, { includePrerelease: true }), `${where} ${range} must admit ${version}`).toBe(true)
      }
    }
  })

  it('refuses a harness without the settings plane, and the next untested minor', () => {
    for (const [where, range] of ranges()) {
      for (const version of REFUSED) {
        expect(satisfies(version, range, { includePrerelease: true }), `${where} ${range} must refuse ${version}`).toBe(false)
      }
    }
  })

  it('waits on the client packages that own the services and slot it uses', () => {
    // `configForms` comes from ui-settings and `plugins.row.config` from the
    // plugin manager; the module graph orders the bundle after both.
    expect([...manifest.dsh.client.inject].toSorted()).toEqual([
      '@deepseek-ai/dsh-client-ui-plugin-manager',
      '@deepseek-ai/dsh-client-ui-settings',
    ])
  })

  it('admits the cordis version the 0.2.1 harness ships', () => {
    const range = manifest.peerDependencies['@deepseek-ai/cordis']
    expect(range, 'cordis must declare a peer range').toBeTypeOf('string')
    expect(satisfies('4.0.5', range!, { includePrerelease: true }), `cordis ${range} must admit 4.0.5`).toBe(true)
  })
})
