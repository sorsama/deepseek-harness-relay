/**
 * Session cookies and bearer tokens are verified on the request hot path, so
 * these cases pin both the forgery cases and the clock behaviour: a system
 * clock step is the realistic way an expiry check goes wrong, not two-party
 * skew.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HarnessSession, HarnessSessionResolver } from '../src/harness-session.ts'
import {
  constantTimeEqual,
  hashToken,
  mintToken,
  readBearer,
  readCookie,
  signSession,
  verifySession,
} from '../src/auth/tokens.ts'

const KEY = 'test-signing-key'
const NOW = 1_700_000_000_000

describe('signSession / verifySession', () => {
  it('round-trips claims', () => {
    const value = signSession(KEY, { subject: 'password', issuedAt: NOW, expiresAt: NOW + 1000 })
    expect(verifySession(KEY, value, NOW)?.subject).toBe('password')
  })

  it('refuses a value signed with another key — this is what rotation relies on', () => {
    const value = signSession(KEY, { subject: 'password', issuedAt: NOW, expiresAt: NOW + 1000 })
    expect(verifySession('rotated', value, NOW)).toBeUndefined()
  })

  it('refuses a tampered payload', () => {
    const value = signSession(KEY, { subject: 'device-a', issuedAt: NOW, expiresAt: NOW + 1000 })
    const forged = Buffer.from(JSON.stringify({ subject: 'password', issuedAt: NOW, expiresAt: NOW + 99_999 }))
      .toString('base64url')
    expect(verifySession(KEY, `${forged}.${value.slice(value.lastIndexOf('.') + 1)}`, NOW)).toBeUndefined()
  })

  it('refuses an expired cookie', () => {
    const value = signSession(KEY, { subject: 'password', issuedAt: NOW - 2000, expiresAt: NOW - 1000 })
    expect(verifySession(KEY, value, NOW)).toBeUndefined()
  })

  it('refuses a cookie issued in the future, so a clock step back cannot revive one', () => {
    const value = signSession(KEY, { subject: 'password', issuedAt: NOW + 60_000, expiresAt: NOW + 120_000 })
    expect(verifySession(KEY, value, NOW)).toBeUndefined()
  })

  it('refuses malformed input rather than throwing', () => {
    for (const value of ['', 'nodot', 'a.b', '.sig']) {
      expect(verifySession(KEY, value, NOW)).toBeUndefined()
    }
  })
})

describe('hashToken', () => {
  it('is keyed, so rotating the signing key invalidates every stored hash', () => {
    const token = mintToken()
    expect(hashToken(KEY, token)).not.toBe(hashToken('rotated', token))
  })

  it('mints distinct tokens', () => {
    expect(mintToken()).not.toBe(mintToken())
  })
})

describe('readCookie', () => {
  it('reads one cookie out of a multi-cookie header', () => {
    expect(readCookie('a=1; dsh_relay_session=abc; b=2', 'dsh_relay_session')).toBe('abc')
  })

  it('decodes percent-encoding and tolerates absence', () => {
    expect(readCookie('x=a%20b', 'x')).toBe('a b')
    expect(readCookie(undefined, 'x')).toBeUndefined()
    expect(readCookie('y=1', 'x')).toBeUndefined()
  })
})

describe('readBearer', () => {
  it('accepts the scheme case-insensitively', () => {
    expect(readBearer('Bearer abc')).toBe('abc')
    expect(readBearer('bearer  abc')).toBe('abc')
  })

  it('rejects other schemes and absence', () => {
    expect(readBearer('Basic abc')).toBeUndefined()
    expect(readBearer(undefined)).toBeUndefined()
    expect(readBearer('Bearer')).toBeUndefined()
  })
})

describe('constantTimeEqual', () => {
  it('compares equal-length values and rejects different lengths', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
  })
})

/** The credential record `dsh-client-connection` stores its signing secret in. */
function record(secret: Buffer): unknown {
  return { kind: 'grant', payload: { version: 1, secret: secret.toString('base64url') } }
}

/** A plugin context whose credentials service answers with whatever `stored` holds. */
function contextReading(read: () => unknown): Parameters<typeof HarnessSession.load>[0] {
  return {
    get: (name: string) => (name === 'credentials' ? { readRecord: async () => read() } : undefined),
  } as unknown as Parameters<typeof HarnessSession.load>[0]
}

describe('HarnessSessionResolver', () => {
  const AUTHORITY = '127.0.0.1:3080'

  it('never remembers a miss, so a cold start heals on the next request', async () => {
    // The bug this pins: the relay mounts before `dsh-client-connection` has
    // written its signing secret. Reading once and keeping the miss left the
    // process forwarding unauthenticated forever — the relay's own pages
    // worked and every proxied request was answered 401.
    let stored: unknown
    let announced = 0
    const resolver = new HarnessSessionResolver(contextReading(() => stored), () => { announced += 1 })
    expect(await resolver.cookieFor(AUTHORITY)).toBeUndefined()
    expect(resolver.available).toBe(false)

    stored = record(randomBytes(32))
    expect(await resolver.cookieFor(AUTHORITY)).toMatch(/^dsh-auth-[\w-]+=v1\.[\w-]+\.[\w-]+$/)
    expect(resolver.available).toBe(true)
    expect(announced).toBe(1)
  })

  it('heals when the credentials service itself attaches late', async () => {
    let credentials: unknown
    const ctx = {
      get: (name: string) => (name === 'credentials' ? credentials : undefined),
    } as unknown as Parameters<typeof HarnessSession.load>[0]
    const resolver = new HarnessSessionResolver(ctx)
    expect(await resolver.cookieFor(AUTHORITY)).toBeUndefined()

    const secret = record(randomBytes(32))
    credentials = { readRecord: async () => secret }
    expect(await resolver.cookieFor(AUTHORITY)).toContain('dsh-auth-')
  })

  it('reads the store once for a burst of concurrent requests', async () => {
    let reads = 0
    const secret = record(randomBytes(32))
    const resolver = new HarnessSessionResolver(contextReading(() => {
      reads += 1
      return secret
    }))
    const cookies = await Promise.all(Array.from({ length: 20 }, () => resolver.cookieFor(AUTHORITY)))
    expect(cookies.every(cookie => cookie?.startsWith('dsh-auth-') === true)).toBe(true)
    expect(reads).toBe(1)
    // Once found, the secret is kept, as the harness keeps its own copy.
    await resolver.cookieFor(AUTHORITY)
    expect(reads).toBe(1)
  })

  it('treats a store that throws as a miss rather than failing the request', async () => {
    const ctx = {
      get: () => ({ readRecord: () => Promise.reject(new Error('disk on fire')) }),
    } as unknown as Parameters<typeof HarnessSession.load>[0]
    const resolver = new HarnessSessionResolver(ctx)
    await expect(resolver.cookieFor(AUTHORITY)).resolves.toBeUndefined()
  })
})
