/**
 * The transport behind computer linking.
 *
 * Two relays on two computers talk to each other over the same TLS listeners
 * they serve to browsers. Each side pins the other's SPKI, so a certificate
 * that changes under a link is a hard failure rather than a silent new trust
 * anchor. Calls are server-to-server: no browser cookies, one bearer token per
 * direction, no redirects followed, and a small body cap.
 *
 * The pinned request deliberately accepts the peer's self-signed certificate
 * first and then verifies its SPKI itself. Node's default verification cannot
 * be used here for the same reason a paired phone pins a key: there is no CA
 * behind a relay's self-signed certificate.
 * @module dsh-relay/peers
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { hostname } from 'node:os'
import type { TLSSocket } from 'node:tls'
import { isLoopbackHostname } from './fence.ts'
import { spkiFingerprint } from './tls.ts'

/** Bytes in an SPKI SHA-256 fingerprint. */
const FINGERPRINT_BYTES = 32

/** Bytes of entropy in an open-handoff nonce. */
const NONCE_BYTES = 24

/** How long one open-handoff nonce stays claimable. */
const OPEN_NONCE_TTL_MS = 60_000

/** Ceiling on a peer's JSON answer. */
const MAX_RESPONSE_BYTES = 64 * 1024

/** This machine's name, as a peer should show it. */
export function peerName(): string {
  const name = hostname().trim()
  return name === '' ? 'PC' : name.slice(0, 64)
}

/**
 * Whether a string is a base64 SHA-256 SPKI fingerprint, the form the pairing
 * page publishes and a QR carries.
 * @param value - the candidate.
 * @returns true for 44 base64 characters that decode to 32 bytes.
 */
export function isFingerprint(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false
  return Buffer.from(value, 'base64').length === FINGERPRINT_BYTES
}

/**
 * Normalize a relay's origin for storage, refusing anything a link cannot use.
 *
 * A link needs a TLS origin reachable from the other computer. Loopback names
 * this machine itself, and link-local or unspecified addresses reach nothing
 * the other PC can use, so both are refused rather than stored and discovered
 * broken later.
 * @param raw - the string an operator typed, or a peer answered with.
 * @returns the canonical `https://host:port` origin, or undefined.
 */
export function normalizePeerOrigin(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === '') return undefined
  if (isLoopbackHostname(host)) return undefined
  if (host === '0.0.0.0' || host === '::') return undefined
  if (host.startsWith('169.254.')) return undefined
  if (host.startsWith('fe80:')) return undefined
  return url.origin
}

/** One peer's answer. */
export interface PeerResponse {
  /** HTTP status. */
  readonly status: number
  /** Body text, at most 64 KiB. */
  readonly body: string
  /** SPKI fingerprint observed during the TLS handshake, when one completed. */
  readonly fingerprint?: string
}

/** One call to a linked relay. */
export interface PeerRequestOptions {
  /** The peer's stored origin. */
  readonly origin: string
  readonly method: 'GET' | 'POST'
  /** Path on the peer, always absolute. */
  readonly path: string
  /** Link token for this direction, when the endpoint wants one. */
  readonly token?: string | undefined
  /** JSON body, for a POST. */
  readonly json?: unknown
  /** Pin to enforce against the presented certificate. */
  readonly pin?: string | undefined
  /** Whole-call deadline. */
  readonly timeoutMs: number
}

/** Compare two strings without leaking their difference through timing. */
function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Call one linked relay over pinned TLS.
 * @param options - where, how, and how long.
 * @returns the answer, with the fingerprint that was actually presented.
 * @throws {Error} with message `pin-mismatch`, `timeout`, or `response-too-large`,
 *   or the underlying socket error.
 */
export function peerRequest(options: PeerRequestOptions): Promise<PeerResponse> {
  const url = new URL(options.path, `${options.origin}/`)
  const body = options.json === undefined ? undefined : JSON.stringify(options.json)
  return new Promise<PeerResponse>((resolve, reject) => {
    const request = httpsRequest({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port === '' ? 443 : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method,
      // Verified below against the pin. Without this switch a self-signed
      // relay could never be called at all.
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        ...body === undefined
          ? {}
          : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      },
    }, (response) => {
      let fingerprint: string | undefined
      try {
        const certificate = (response.socket as TLSSocket).getPeerCertificate()
        fingerprint = certificate.raw === undefined ? undefined : spkiFingerprint(certificate.raw)
      } catch {
        fingerprint = undefined
      }
      if (options.pin !== undefined && (fingerprint === undefined || !sameString(fingerprint, options.pin))) {
        response.destroy()
        reject(new Error('pin-mismatch'))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('response-too-large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          ...fingerprint === undefined ? {} : { fingerprint },
        })
      })
    })
    request.setTimeout(options.timeoutMs, () => { request.destroy(new Error('timeout')) })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/**
 * One-use nonces for the open handoff.
 *
 * Held in memory on purpose: a relay restart invalidates every outstanding
 * handoff, which is the safe direction, and nothing here outlives a minute.
 */
export class OpenNonceStore {
  readonly #entries = new Map<string, { readonly peerId: string, readonly expiresAt: number }>()

  /**
   * Mint a nonce for one peer.
   * @param peerId - the linked computer opening this relay.
   * @param now - current epoch millis.
   * @param ttlMs - how long it stays claimable.
   * @returns the opaque nonce.
   */
  issue(peerId: string, now: number, ttlMs = OPEN_NONCE_TTL_MS): string {
    for (const [nonce, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(nonce)
    }
    const nonce = randomBytes(NONCE_BYTES).toString('base64url')
    this.#entries.set(nonce, { peerId, expiresAt: now + ttlMs })
    return nonce
  }

  /**
   * Claim a nonce, once.
   * @param nonce - the value from the handoff URL.
   * @param now - current epoch millis.
   * @returns the peer it was minted for, or undefined when unknown or expired.
   */
  consume(nonce: string, now: number): string | undefined {
    const entry = this.#entries.get(nonce)
    if (entry === undefined) return undefined
    this.#entries.delete(nonce)
    return now >= entry.expiresAt ? undefined : entry.peerId
  }
}
