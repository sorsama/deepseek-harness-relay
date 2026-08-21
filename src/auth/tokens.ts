/**
 * Signed session cookies and device bearer tokens.
 *
 * Both verify with one HMAC against an in-memory key, because the mobile
 * client opens two WebSockets inside a 3-second budget and then calls
 * `host.describe`: anything that touches the filesystem or re-derives a
 * password hash on that path turns a working connection into a backoff loop.
 *
 * Rotating the signing key invalidates every cookie and every device token at
 * once — that is what "sign out everywhere" does.
 * @module dsh-relay/auth/tokens
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Bytes of entropy in a device bearer token. */
const TOKEN_BYTES = 32

/** Bytes of entropy in a device id. */
const DEVICE_ID_BYTES = 8

/** Fields carried inside a signed session cookie. */
export interface SessionClaims {
  /** Subject: `password` for a browser sign-in, or a device id. */
  readonly subject: string
  /** Epoch millis the cookie was issued. */
  readonly issuedAt: number
  /** Epoch millis the cookie stops being accepted. */
  readonly expiresAt: number
}

/**
 * Compare two strings without leaking their difference through timing.
 * @param a - first value.
 * @param b - second value.
 * @returns true when the values are byte-identical.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Mint a new bearer token.
 * @returns a URL-safe token; only its hash is ever stored.
 */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Mint a new device id.
 * @returns a short opaque id, also the revocation handle.
 */
export function mintDeviceId(): string {
  return randomBytes(DEVICE_ID_BYTES).toString('hex')
}

/**
 * Hash a bearer token for storage and for the in-memory lookup index.
 * @param signingKey - the relay's current signing key.
 * @param token - the bearer token as presented.
 * @returns the keyed hash, hex.
 */
export function hashToken(signingKey: string, token: string): string {
  return createHmac('sha256', signingKey).update(token).digest('hex')
}

/**
 * Sign a set of session claims into a cookie value.
 * @param signingKey - the relay's current signing key.
 * @param claims - the claims to carry.
 * @returns `<payload>.<signature>`, both base64url.
 */
export function signSession(signingKey: string, claims: SessionClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const signature = createHmac('sha256', signingKey).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

/**
 * Verify a cookie value and return its claims.
 *
 * A clock step backwards — suspend and resume, an NTP correction — would
 * otherwise make a long-lived cookie appear freshly issued or instantly
 * expired, so a cookie claiming to be issued in the future is refused rather
 * than trusted.
 * @param signingKey - the relay's current signing key.
 * @param value - the cookie value as presented.
 * @param now - current epoch millis.
 * @returns the claims, or undefined when the value is forged, malformed, or expired.
 */
export function verifySession(signingKey: string, value: string, now: number): SessionClaims | undefined {
  const separator = value.lastIndexOf('.')
  if (separator <= 0) return undefined
  const payload = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  const expected = createHmac('sha256', signingKey).update(payload).digest('base64url')
  if (!constantTimeEqual(signature, expected)) return undefined
  let claims: SessionClaims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims
  } catch {
    return undefined
  }
  if (typeof claims.subject !== 'string') return undefined
  if (typeof claims.issuedAt !== 'number' || typeof claims.expiresAt !== 'number') return undefined
  if (now >= claims.expiresAt) return undefined
  if (now < claims.issuedAt) return undefined
  return claims
}

/**
 * Read one cookie out of a request's `Cookie` header.
 * @param header - the raw header value, or undefined.
 * @param name - the cookie name.
 * @returns the decoded value, or undefined when absent.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return undefined
}

/**
 * Read a bearer credential from an `Authorization` header.
 * @param header - the raw header value, or undefined.
 * @returns the token, or undefined when the header is absent or not a bearer.
 */
export function readBearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer +(\S+)$/i.exec(header.trim())
  return match?.[1]
}
