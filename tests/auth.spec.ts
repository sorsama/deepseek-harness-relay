/**
 * The credential state machine: what each class of caller is, what it may
 * reach, and what revocation actually revokes.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator } from '../src/auth/index.ts'
import { Config, assertCoherent, type Config as RelayConfig } from '../src/config.ts'
import { RelayStore } from '../src/state.ts'

const NOW = 1_700_000_000_000

let dir: string
let store: RelayStore

/** A resolved config with the schema's own defaults applied. */
function configFor(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return Config({ stateDir: dir, ...overrides }) as RelayConfig
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
  store = await RelayStore.open(dir)
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('RelayStore', () => {
  it('creates a state file with a signing key on first open', () => {
    expect(store.state.signingKey).toMatch(/^[\w-]{20,}$/)
    expect(store.state.devices).toEqual({})
  })

  it('persists across reopen', async () => {
    await store.update((draft) => { draft.signingKey = 'pinned' })
    const reopened = await RelayStore.open(dir)
    expect(reopened.state.signingKey).toBe('pinned')
    await reopened.close()
  })

  it('serializes concurrent updates instead of losing one', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((draft) => {
      draft.grants[`10.0.0.${String(index)}`] = {
        address: `10.0.0.${String(index)}`,
        deviceId: 'd',
        createdAt: NOW,
        expiresAt: NOW + 1000,
      }
    })))
    expect(Object.keys(store.state.grants)).toHaveLength(20)
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { grants: object }
    expect(Object.keys(onDisk.grants)).toHaveLength(20)
  })

  it('refuses a file from another format version rather than resetting to "no password"', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 99, devices: {}, grants: {} }))
    await expect(RelayStore.open(dir)).rejects.toThrow(/format version/)
  })
})

describe('Authenticator', () => {
  it('treats a loopback caller as privileged without any credential', () => {
    const auth = new Authenticator(store, configFor())
    const identity = auth.identify({ headers: {}, address: '127.0.0.1', local: true }, NOW)
    expect(identity).toEqual({ credential: 'loopback', privileged: true })
    auth.dispose()
  })

  it('gives an unknown caller nothing', () => {
    const auth = new Authenticator(store, configFor())
    expect(auth.identify({ headers: {}, address: '192.168.1.9', local: false }, NOW))
      .toEqual({ credential: 'none', privileged: false })
    auth.dispose()
  })

  describe('pairing', () => {
    it('mints a device token that then authenticates', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 300_000, NOW)
      const paired = await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      expect(paired).toBeDefined()
      const identity = auth.identify({
        headers: { authorization: `Bearer ${paired!.token}` },
        address: '192.168.1.9',
        local: false,
      }, NOW)
      expect(identity.credential).toBe('device')
      expect(identity.deviceId).toBe(paired!.device.id)
      auth.dispose()
    })

    it('consumes the code, so an intercepted one is worthless after use', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 300_000, NOW)
      expect(await auth.pair({ code: code.code, name: 'first', address: '192.168.1.9' }, NOW)).toBeDefined()
      expect(await auth.pair({ code: code.code, name: 'second', address: '192.168.1.10' }, NOW)).toBeUndefined()
      auth.dispose()
    })

    it('refuses an expired code', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 1000, NOW)
      expect(await auth.pair({ code: code.code, name: 'late', address: '192.168.1.9' }, NOW + 2000)).toBeUndefined()
      auth.dispose()
    })

    it('locks an address out after repeated wrong codes', async () => {
      const auth = new Authenticator(store, configFor({ maxFailedAttempts: 3 }))
      auth.pairing.issue(8, 300_000, NOW)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await auth.pair({ code: '00000000', name: 'x', address: '192.168.1.9' }, NOW)).toBeUndefined()
      }
      const code = auth.pairing.issue(8, 300_000, NOW)
      // The correct code now fails too, because the address is locked out — and it says so rather
      // than reporting a bad code, which would send someone to fetch a fresh one that cannot help.
      expect(await auth.pair({ code: code.code, name: 'x', address: '192.168.1.9' }, NOW)).toBe('locked-out')
      expect(auth.lockedUntil('192.168.1.9', NOW)).toBeGreaterThan(NOW)
      // And an address that never failed is not swept up in it.
      expect(auth.lockedUntil('192.168.1.10', NOW)).toBeUndefined()
      auth.dispose()
    })
  })

  describe('address grants', () => {
    it('admits a private address a paired device used, but never as privileged', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 300_000, NOW)
      await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      const identity = auth.identify({ headers: {}, address: '192.168.1.9', local: false }, NOW)
      expect(identity.credential).toBe('address-grant')
      // A source address is shared, reassigned, and spoofable; it cannot carry
      // the configuration plane no matter how the operator configured it.
      expect(identity.privileged).toBe(false)
      auth.dispose()
    })

    it('never grants a public address, which is shared behind carrier NAT', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 300_000, NOW)
      await auth.pair({ code: code.code, name: 'Pixel', address: '203.0.113.7' }, NOW)
      expect(auth.identify({ headers: {}, address: '203.0.113.7', local: false }, NOW).credential).toBe('none')
      auth.dispose()
    })

    it('expires', async () => {
      const auth = new Authenticator(store, configFor({
        compat: { addressGrants: true, addressGrantTtlMs: 60_000, plainPort: 0 },
      }))
      const code = auth.pairing.issue(8, 300_000, NOW)
      await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      expect(auth.identify({ headers: {}, address: '192.168.1.9', local: false }, NOW + 61_000).credential).toBe('none')
      auth.dispose()
    })

    it('is not issued at all when the operator turned it off', async () => {
      const auth = new Authenticator(store, configFor({
        compat: { addressGrants: false, addressGrantTtlMs: 60_000, plainPort: 0 },
      }))
      const code = auth.pairing.issue(8, 300_000, NOW)
      await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      expect(auth.identify({ headers: {}, address: '192.168.1.9', local: false }, NOW).credential).toBe('none')
      auth.dispose()
    })
  })

  describe('privileged policy', () => {
    it('withholds the configuration plane when the operator pinned it to loopback', async () => {
      const auth = new Authenticator(store, configFor({ privilegedMethods: 'loopback-only' }))
      const code = auth.pairing.issue(8, 300_000, NOW)
      const paired = await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      const identity = auth.identify({
        headers: { authorization: `Bearer ${paired!.token}` },
        address: '192.168.1.9',
        local: false,
      }, NOW)
      expect(identity.credential).toBe('device')
      expect(identity.privileged).toBe(false)
      auth.dispose()
    })
  })

  describe('revocation', () => {
    it('drops the token and the grant together', async () => {
      const auth = new Authenticator(store, configFor())
      const code = auth.pairing.issue(8, 300_000, NOW)
      const paired = await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)
      await auth.revoke(paired!.device.id, NOW)
      expect(auth.identify({
        headers: { authorization: `Bearer ${paired!.token}` },
        address: '192.168.1.9',
        local: false,
      }, NOW).credential).toBe('none')
      expect(auth.identify({ headers: {}, address: '192.168.1.9', local: false }, NOW).credential).toBe('none')
      expect(auth.devices).toHaveLength(0)
      auth.dispose()
    })

    it('signing out everywhere invalidates cookies and every device at once', async () => {
      const auth = new Authenticator(store, configFor())
      await auth.setPassword('correct horse battery')
      const signedIn = await auth.signIn('correct horse battery', '192.168.1.9', NOW)
      expect(typeof signedIn).not.toBe('string')
      const cookie = (signedIn as { cookie: string }).cookie
      const code = auth.pairing.issue(8, 300_000, NOW)
      const paired = await auth.pair({ code: code.code, name: 'Pixel', address: '192.168.1.9' }, NOW)

      await auth.signOutEverywhere()

      expect(auth.identify({ headers: { cookie: `dsh_relay_session=${cookie}` }, address: '192.168.1.9', local: false }, NOW).credential).toBe('none')
      expect(auth.identify({ headers: { authorization: `Bearer ${paired!.token}` }, address: '192.168.1.9', local: false }, NOW).credential).toBe('none')
      auth.dispose()
    })
  })

  describe('password sign-in', () => {
    it('reports the reason it refused, and locks out after repeated failures', async () => {
      const auth = new Authenticator(store, configFor({ maxFailedAttempts: 2 }))
      expect(await auth.signIn('anything', '192.168.1.9', NOW)).toBe('no-password')
      await auth.setPassword('correct horse battery')
      expect(await auth.signIn('wrong', '192.168.1.9', NOW)).toBe('bad-password')
      expect(await auth.signIn('wrong', '192.168.1.9', NOW)).toBe('bad-password')
      expect(await auth.signIn('correct horse battery', '192.168.1.9', NOW)).toBe('locked-out')
      auth.dispose()
    }, 20_000)

    it('a successful sign-in clears the failure counter', async () => {
      const auth = new Authenticator(store, configFor({ maxFailedAttempts: 3 }))
      await auth.setPassword('correct horse battery')
      expect(await auth.signIn('wrong', '192.168.1.9', NOW)).toBe('bad-password')
      expect(typeof await auth.signIn('correct horse battery', '192.168.1.9', NOW)).not.toBe('string')
      expect(await auth.signIn('wrong', '192.168.1.9', NOW)).toBe('bad-password')
      expect(await auth.signIn('wrong', '192.168.1.9', NOW)).toBe('bad-password')
      expect(typeof await auth.signIn('correct horse battery', '192.168.1.9', NOW)).not.toBe('string')
      auth.dispose()
    }, 30_000)
  })
})

describe('assertCoherent', () => {
  it('refuses a files posture with no files named', () => {
    expect(() => { assertCoherent(configFor({ tls: 'files' })) }).toThrow(/tlsCertPath/)
  })

  it('refuses a compatibility listener on the primary port', () => {
    expect(() => {
      assertCoherent(configFor({ port: 3443, compat: { addressGrants: true, addressGrantTtlMs: 60_000, plainPort: 3443 } }))
    }).toThrow(/must differ/)
  })

  it('allows a compatibility listener with address grants off', () => {
    // It used to refuse this pair, on the reasoning that the plain listener served only
    // address-granted clients. That stopped being true once a client could hold a token: the
    // listener accepts the `device` class, so it is reachable with grants off — which is exactly
    // the configuration an operator reaches for once every client has paired.
    expect(() => {
      assertCoherent(configFor({ compat: { addressGrants: false, addressGrantTtlMs: 60_000, plainPort: 8080 } }))
    }).not.toThrow()
  })

  it('refuses a relative extra proxy path', () => {
    expect(() => { assertCoherent(configFor({ extraProxyPaths: ['api'] })) }).toThrow(/must start with/)
  })
})
