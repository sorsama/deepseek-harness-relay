/**
 * Session cookies and bearer tokens are verified on the request hot path, so
 * these cases pin both the forgery cases and the clock behaviour: a system
 * clock step is the realistic way an expiry check goes wrong, not two-party
 * skew.
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HarnessSession } from '../src/harness-session.ts'
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

describe('HarnessSessionResolver', () => {
  it('never memoizes a miss, so a cold start heals once the secret appears', async () => {
    // The bug this pins: the relay mounts before `dsh-client-connection` has
    // written its signing secret. Reading once and caching the miss left the
    // process forwarding unauthenticated forever — the relay's own pages worked
    // and every proxied request was answered 401, for the life of the process.
    const secret = randomBytes(32)
    let stored: unknown
    const ctx = {
      get: (name: string) => (name === 'credentials'
        ? { readRecord: async () => stored }
        : undefined),
    } as unknown as Parameters<typeof HarnessSession.lazy>[0]

    const resolver = HarnessSession.lazy(ctx)
    expect(await resolver.current()).toBeUndefined()
    expect(resolver.ready).toBe(false)
    expect(resolver.sync()).toBeUndefined()

    // The harness writes the secret after the relay has already started.
    stored = {
      kind: 'grant',
      payload: { version: 1, secret: secret.toString('base64url') },
    }
    const recovered = await resolver.current()
    expect(recovered).toBeDefined()
    expect(resolver.ready).toBe(true)
    // The request path reads this synchronously, so it must see the recovery.
    expect(resolver.sync()).toBe(recovered)
    expect(resolver.markRecovered()).toBe(true)
    expect(resolver.markRecovered()).toBe(false)
  })

  it('picks up a rotated secret instead of freezing the first one', async () => {
    const first = randomBytes(32)
    const second = randomBytes(32)
    let stored: unknown = {
      kind: 'grant',
      payload: { version: 1, secret: first.toString('base64url') },
    }
    const ctx = {
      get: () => ({ readRecord: async () => stored }),
    } as unknown as Parameters<typeof HarnessSession.lazy>[0]

    const resolver = HarnessSession.lazy(ctx)
    const one = await resolver.current()
    expect(one?.cookieFor('127.0.0.1:3080')).toContain('v1.')

    stored = { kind: 'grant', payload: { version: 1, secret: second.toString('base64url') } }
    const two = await resolver.current()
    expect(two).not.toBe(one)
    expect(resolver.sync()).toBe(two)
  })
})
