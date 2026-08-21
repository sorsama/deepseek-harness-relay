/**
 * The fence is the relay's whole defence against a rebound page, because
 * proxying rewrites `Host` to loopback and the harness's own fence therefore
 * sees every request as local. These cases pin the vectors it must refuse.
 */
import { describe, expect, it } from 'vitest'
import {
  assertTrustedAuthority,
  checkFence,
  isLoopbackHostname,
  isPrivateAddress,
  relayAuthorities,
} from '../src/fence.ts'

const AUTHORITIES = ['127.0.0.1', 'localhost', '192.168.1.5', 'relay.example.com:8443']

describe('checkFence', () => {
  it('admits a loopback host with no browser markers', () => {
    expect(checkFence({ headers: { host: '127.0.0.1:3443' } }, AUTHORITIES)).toBeUndefined()
  })

  it('admits a declared LAN literal on any port, because the bind may be OS-assigned', () => {
    expect(checkFence({ headers: { host: '192.168.1.5:54321' } }, AUTHORITIES)).toBeUndefined()
  })

  it('refuses a rebound host — the attacker domain the browser still sends', () => {
    expect(checkFence({ headers: { host: 'evil.example' } }, AUTHORITIES)).toBe('untrusted-host')
    expect(checkFence({ headers: { host: 'evil.example:3443' } }, AUTHORITIES)).toBe('untrusted-host')
  })

  it('refuses a request with no host at all', () => {
    expect(checkFence({ headers: {} }, AUTHORITIES)).toBe('missing-host')
  })

  it('refuses an explicit cross-site marker even on a trusted host', () => {
    expect(checkFence({
      headers: { host: '192.168.1.5:3443', 'sec-fetch-site': 'cross-site' },
    }, AUTHORITIES)).toBe('cross-site')
  })

  it('admits a same-origin marker', () => {
    expect(checkFence({
      headers: { host: '192.168.1.5:3443', 'sec-fetch-site': 'same-origin' },
    }, AUTHORITIES)).toBeUndefined()
  })

  it('refuses an opaque origin from a sandboxed frame or a file: page', () => {
    expect(checkFence({ headers: { host: '127.0.0.1:3443', origin: 'null' } }, AUTHORITIES)).toBe('opaque-origin')
  })

  it('requires an attached origin to match the host exactly', () => {
    expect(checkFence({
      headers: { host: '192.168.1.5:3443', origin: 'https://192.168.1.5:3443' },
    }, AUTHORITIES)).toBeUndefined()
    expect(checkFence({
      headers: { host: '192.168.1.5:3443', origin: 'https://192.168.1.5:9999' },
    }, AUTHORITIES)).toBe('origin-mismatch')
  })

  it('admits an absent origin, which is what the native client sends', () => {
    expect(checkFence({ headers: { host: '192.168.1.5:3443' } }, AUTHORITIES)).toBeUndefined()
  })

  it('honours an exact-port grant only on that port', () => {
    expect(checkFence({ headers: { host: 'relay.example.com:8443' } }, AUTHORITIES)).toBeUndefined()
    expect(checkFence({ headers: { host: 'relay.example.com:9443' } }, AUTHORITIES)).toBe('untrusted-host')
  })

  it('refuses an unparsable authority rather than guessing', () => {
    expect(checkFence({ headers: { host: 'a b c' } }, AUTHORITIES)).toBe('unparsable-host')
  })
})

describe('assertTrustedAuthority', () => {
  it('accepts bare canonical authorities', () => {
    expect(() => { assertTrustedAuthority('relay.example.com') }).not.toThrow()
    expect(() => { assertTrustedAuthority('relay.example.com:8443') }).not.toThrow()
    expect(() => { assertTrustedAuthority('192.168.1.5') }).not.toThrow()
  })

  it('refuses anything parsing would silently rewrite', () => {
    // A path would authorize more than the operator wrote.
    expect(() => { assertTrustedAuthority('relay.example.com/admin') }).toThrow()
    // Userinfo would authorize the embedded hostname instead.
    expect(() => { assertTrustedAuthority('user@relay.example.com') }).toThrow()
    // A zero-padded port would widen an intended exact-port grant to every port.
    expect(() => { assertTrustedAuthority('relay.example.com:08443') }).toThrow()
    expect(() => { assertTrustedAuthority('0x7f.0.0.1') }).toThrow()
    expect(() => { assertTrustedAuthority('  relay.example.com') }).toThrow()
  })
})

describe('isLoopbackHostname', () => {
  it('covers the whole 127/8 block plus the named forms', () => {
    for (const name of ['localhost', '[::1]', '127.0.0.1', '127.13.9.2']) {
      expect(isLoopbackHostname(name), name).toBe(true)
    }
    for (const name of ['128.0.0.1', '192.168.1.5', 'relay.example.com', '127.0.0']) {
      expect(isLoopbackHostname(name), name).toBe(false)
    }
  })
})

describe('isPrivateAddress', () => {
  it('accepts the ranges a home or office network actually uses', () => {
    for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.5', '169.254.1.1', '127.0.0.1', '::1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateAddress(address), address).toBe(true)
    }
  })

  it('refuses public addresses, which are shared behind carrier NAT', () => {
    for (const address of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '203.0.113.7', '2001:db8::1']) {
      expect(isPrivateAddress(address), address).toBe(false)
    }
  })

  it('unwraps the IPv4-mapped form a dual-stack listener reports', () => {
    expect(isPrivateAddress('::ffff:192.168.1.5')).toBe(true)
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('relayAuthorities', () => {
  it('always includes loopback and deduplicates', () => {
    const authorities = relayAuthorities({ trustedHosts: ['relay.example.com'], publicHostnames: ['relay.example.com'] })
    expect(authorities).toContain('127.0.0.1')
    expect(authorities).toContain('localhost')
    expect(authorities.filter(entry => entry === 'relay.example.com')).toHaveLength(1)
  })
})
