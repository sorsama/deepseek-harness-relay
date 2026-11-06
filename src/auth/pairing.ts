/**
 * Device enrolment.
 *
 * A pairing code is created only by an operator action arriving on loopback —
 * the admin page opened on the machine running the harness, or the plugin's
 * own startup banner. It is never created by a request from the device asking
 * to be paired: an endpoint that mints its own invitations on demand is the
 * confused deputy the rest of this plugin exists to avoid.
 *
 * A code is single use, expires on a short window, and is compared in constant
 * time. Claiming one mints a bearer token whose hash is all the relay stores.
 * @module dsh-relay/auth/pairing
 */

import { randomInt } from 'node:crypto'
import { constantTimeEqual } from './tokens.ts'

/** One outstanding invitation. */
export interface PairingCode {
  /** The digits the operator reads out, or that the QR carries. */
  readonly code: string
  /** Epoch millis the code stops being claimable. */
  readonly expiresAt: number
}

/**
 * The live pairing window.
 *
 * At most one code is outstanding: a second `issue()` replaces the first, so
 * an operator who re-opens the pairing screen cannot accidentally leave a
 * forgotten invitation valid behind them.
 */
export class PairingWindow {
  #current: PairingCode | undefined

  /**
   * Issue a fresh code, replacing any outstanding one.
   * @param digits - length of the numeric code.
   * @param windowMs - how long it stays claimable.
   * @param now - current epoch millis.
   * @returns the new code.
   */
  issue(digits: number, windowMs: number, now: number): PairingCode {
    let code = ''
    while (code.length < digits) code += String(randomInt(0, 10))
    this.#current = { code, expiresAt: now + windowMs }
    return this.#current
  }

  /**
   * The outstanding code, if one is still claimable.
   * @param now - current epoch millis.
   * @returns the code, or undefined when none is outstanding or it expired.
   */
  peek(now: number): PairingCode | undefined {
    if (this.#current === undefined) return undefined
    if (now >= this.#current.expiresAt) {
      this.#current = undefined
      return undefined
    }
    return this.#current
  }

  /**
   * Claim the outstanding code.
   *
   * Success consumes it, so a code intercepted in transit is worthless once
   * the intended device has used it — and an operator who sees an unexpected
   * "already paired" is being told the code leaked.
   * @param candidate - the code as presented.
   * @param now - current epoch millis.
   * @returns true when the code matched and has now been consumed.
   */
  claim(candidate: string, now: number): boolean {
    const current = this.peek(now)
    if (current === undefined) return false
    if (!constantTimeEqual(candidate, current.code)) return false
    this.#current = undefined
    return true
  }

  /** Withdraw any outstanding code. */
  clear(): void {
    this.#current = undefined
  }
}

/** What a QR code carries, and what a client needs to reach and trust the relay. */
export interface PairingPayload {
  /** Payload format version. */
  readonly v: 1
  /** Discriminator, so a scanner can tell this QR from any other. */
  readonly kind: 'dsh-relay-pair'
  /** Primary origin, including scheme and port. Always the one to try first. */
  readonly url: string
  /**
   * Other origins that serve this same relay, most likely first.
   *
   * Present when the machine has more than one network address. A client that
   * knows this field may fail over to the next origin when `url` does not
   * answer; one that does not can ignore it, which is why it is additive and
   * `v` stays 1.
   */
  readonly urls?: readonly string[]
  /** Plain-HTTP origin for clients that cannot speak TLS; absent when none is listening. */
  readonly plainUrl?: string
  /** SHA-256 of the DER SubjectPublicKeyInfo, base64; absent when the relay serves plaintext. */
  readonly fingerprint?: string
  /** The single-use enrolment code. */
  readonly code: string
  /** Epoch millis the code stops being claimable. */
  readonly expiresAt: number
}

/**
 * Build the payload a QR code or a copied link carries.
 * @param parts - the relay's reachable origins, certificate identity, and live code.
 * @returns the payload, ready to serialize.
 */
export function pairingPayload(parts: {
  readonly url: string
  readonly urls?: readonly string[] | undefined
  readonly plainUrl?: string | undefined
  readonly fingerprint?: string | undefined
  readonly code: PairingCode
}): PairingPayload {
  // The chosen origin is always first even if the caller handed it later:
  // every client reads `url`, so that field must be the best guess.
  const urls = parts.urls === undefined ? undefined : [...new Set([parts.url, ...parts.urls])]
  return {
    v: 1,
    kind: 'dsh-relay-pair',
    url: parts.url,
    ...urls !== undefined && urls.length > 1 && { urls },
    ...parts.plainUrl !== undefined && { plainUrl: parts.plainUrl },
    ...parts.fingerprint !== undefined && { fingerprint: parts.fingerprint },
    code: parts.code.code,
    expiresAt: parts.code.expiresAt,
  }
}
