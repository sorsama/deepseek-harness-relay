/**
 * Single-use codes that turn a paired device's bearer token into a browser
 * session.
 *
 * A paired app holds a bearer token, and an embedded WebView cannot attach a
 * header to the requests its page makes on its own: subresources, `fetch`
 * calls, and WebSocket upgrades all go out with cookies only. So the app trades
 * its token for a code over its own authenticated connection, and the WebView
 * redeems the code with one navigation, which sets the cookie.
 *
 * The code is the only secret that ever appears in a URL, and it is built to
 * survive appearing there: it works once, for one minute, and only while the
 * device that asked for it is still paired. Held in memory on purpose — a
 * relay restart drops every outstanding code, which is the safe direction.
 * @module dsh-relay/auth/handoff
 */

import { randomBytes } from 'node:crypto'

/** Bytes of entropy in one handoff code. */
const CODE_BYTES = 24

/** How long one code stays redeemable. */
export const HANDOFF_TTL_MS = 60_000

/**
 * Outstanding codes one device may hold at once.
 *
 * An app asks for a code each time it creates its WebView. A handful covers a
 * retry or two; more than that is a loop, and the oldest code is the one to
 * drop because it is the one least likely to still be wanted.
 */
const MAX_PER_DEVICE = 8

/** Outstanding codes across every device, so a misbehaving client cannot grow this without bound. */
const MAX_TOTAL = 512

/** What a redeemed code carries. */
export interface HandoffGrant {
  /** The device the session will belong to. */
  readonly deviceId: string
  /** Same-origin path the browser lands on after the cookie is set. */
  readonly next: string
}

/** One outstanding code. */
interface Entry extends HandoffGrant {
  readonly issuedAt: number
  readonly expiresAt: number
}

/** The outstanding handoff codes of one running relay. */
export class HandoffCodes {
  readonly #entries = new Map<string, Entry>()

  /**
   * Mint a code for one device.
   * @param deviceId - the paired device asking.
   * @param next - same-origin path to land on, already validated.
   * @param now - current epoch millis.
   * @returns the opaque code and when it stops being redeemable.
   */
  issue(deviceId: string, next: string, now: number): { readonly code: string, readonly expiresAt: number } {
    this.#sweep(now)
    const mine = [...this.#entries].filter(([, entry]) => entry.deviceId === deviceId)
    // Insertion order is issue order, so the head of the list is the oldest.
    for (const [code] of mine.slice(0, Math.max(0, mine.length - MAX_PER_DEVICE + 1))) this.#entries.delete(code)
    if (this.#entries.size >= MAX_TOTAL) {
      const oldest = this.#entries.keys().next()
      if (oldest.done !== true) this.#entries.delete(oldest.value)
    }
    const code = randomBytes(CODE_BYTES).toString('base64url')
    const expiresAt = now + HANDOFF_TTL_MS
    this.#entries.set(code, { deviceId, next, issuedAt: now, expiresAt })
    return { code, expiresAt }
  }

  /**
   * Redeem a code, once.
   *
   * The entry is deleted before it is judged, so a code that fails for being
   * expired is as spent as one that succeeded.
   * @param code - the value from the handoff URL.
   * @param now - current epoch millis.
   * @returns the device and landing path, or undefined when unknown, used, or expired.
   */
  consume(code: string, now: number): HandoffGrant | undefined {
    const entry = this.#entries.get(code)
    if (entry === undefined) return undefined
    this.#entries.delete(code)
    // A clock step backwards would otherwise make an old code look fresh.
    if (now >= entry.expiresAt || now < entry.issuedAt) return undefined
    return { deviceId: entry.deviceId, next: entry.next }
  }

  /**
   * Drop every outstanding code of one device, for when it is unpaired.
   * @param deviceId - the revoked device.
   */
  revokeDevice(deviceId: string): void {
    for (const [code, entry] of this.#entries) {
      if (entry.deviceId === deviceId) this.#entries.delete(code)
    }
  }

  /** Drop every outstanding code. */
  clear(): void {
    this.#entries.clear()
  }

  /** How many codes are outstanding, expired ones included until the next issue. */
  get size(): number {
    return this.#entries.size
  }

  /** Forget expired codes. */
  #sweep(now: number): void {
    for (const [code, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(code)
    }
  }
}
