/**
 * Who is asking, and what that entitles them to.
 *
 * Every inbound request is classified into exactly one credential class before
 * anything is proxied. The classes are ordered by strength, and only the two
 * strongest reach the harness methods that are otherwise pinned to loopback:
 * a source address is not a credential, and the compatibility class that rests
 * on one is fenced accordingly.
 *
 * Verification on the request path is one HMAC against in-memory state. The
 * mobile client opens two WebSockets inside a 3-second budget and then calls
 * `host.describe`; a filesystem read or a scrypt derivation on that path turns
 * a working connection into a reconnect loop.
 * @module dsh-relay/auth
 */

import type { IncomingHttpHeaders } from 'node:http'
import type { Config } from '../config.ts'
import type { DeviceRecord, RelayStore } from '../state.ts'
import { isPrivateAddress } from '../fence.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { PairingWindow } from './pairing.ts'
import { Throttle } from './ratelimit.ts'
import { hashToken, mintDeviceId, mintToken, readBearer, readCookie, signSession, verifySession } from './tokens.ts'

/** Name of the signed sign-in cookie. */
export const SESSION_COOKIE = 'dsh_relay_session'

/** How a request proved who it is. */
export type CredentialClass = 'loopback' | 'session' | 'device' | 'address-grant' | 'none'

/** The verdict for one request. */
export interface Identity {
  readonly credential: CredentialClass
  /** Device this request belongs to, when one is known. */
  readonly deviceId?: string
  /**
   * Whether this request may reach the methods the harness pins to loopback.
   *
   * True for a genuine loopback caller always, and for a session or device
   * credential when the operator configured `privilegedMethods` to allow it.
   * Never true for an address grant: a source address is shared behind NAT,
   * reassigned by DHCP, rotated by IPv6 privacy extensions, and spoofable on
   * the same segment, so it cannot carry the configuration plane.
   */
  readonly privileged: boolean
}

/** A request's identifying facts. */
export interface AuthRequest {
  readonly headers: IncomingHttpHeaders
  /** Peer address of the socket, already normalized. */
  readonly address: string
  /** Whether the peer address is loopback. */
  readonly local: boolean
}

/** The refusal reason, when a sign-in attempt fails. */
export type SignInFailure = 'no-password' | 'locked-out' | 'bad-password'

/** Result of a successful sign-in. */
export interface SignInSuccess {
  /** The cookie value to set. */
  readonly cookie: string
  /** Epoch millis the cookie expires. */
  readonly expiresAt: number
}

/**
 * The relay's authentication state.
 *
 * Owns the in-memory token index, the pairing window, and the throttles; the
 * durable half lives in {@link RelayStore}.
 */
export class Authenticator {
  /** token hash → device id, rebuilt from the store on construction and on every mutation. */
  #tokenIndex = new Map<string, string>()
  readonly #throttle: Throttle
  readonly pairing = new PairingWindow()

  /**
   * @param store - the durable state store.
   * @param config - resolved plugin configuration.
   */
  constructor(private readonly store: RelayStore, private readonly config: Config) {
    this.#throttle = new Throttle({
      requestsPerMinute: config.rateLimitPerMinute,
      maxFailures: config.maxFailedAttempts,
      lockoutMs: config.lockoutMs,
    })
    this.#reindex()
  }

  /** Rebuild the token lookup index from durable state. */
  #reindex(): void {
    const index = new Map<string, string>()
    for (const device of Object.values(this.store.state.devices)) {
      if (device.revokedAt !== undefined) continue
      index.set(device.tokenHash, device.id)
    }
    this.#tokenIndex = index
  }

  /** Whether a password has been set at all. */
  get hasPassword(): boolean {
    return this.store.state.password !== undefined
  }

  /** Live, unrevoked devices, newest first. */
  get devices(): DeviceRecord[] {
    return Object.values(this.store.state.devices)
      .filter(device => device.revokedAt === undefined)
      .toSorted((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Record one request against the per-address rate limit.
   * @param address - normalized source address.
   * @param now - current epoch millis.
   * @returns true when the request is over the limit and must be refused.
   */
  exceedsRate(address: string, now: number): boolean {
    return this.#throttle.exceedsRate(address, now)
  }

  /**
   * When an address's lockout expires, or undefined when it is not locked out.
   * @param address - the normalized source address.
   * @param now - current epoch millis.
   * @returns epoch millis the lockout lifts.
   */
  lockedUntil(address: string, now: number): number | undefined {
    return this.#throttle.lockedUntil(address, now)
  }

  /**
   * Classify one request.
   * @param request - the request's headers, source address, and locality.
   * @param now - current epoch millis.
   * @returns the credential class and what it entitles the caller to.
   */
  identify(request: AuthRequest, now: number): Identity {
    const allowPrivileged = this.config.privilegedMethods === 'allow-authenticated'
    if (request.local) return { credential: 'loopback', privileged: true }

    const bearer = readBearer(request.headers.authorization)
    if (bearer !== undefined) {
      const device = this.#deviceForToken(bearer, now)
      if (device !== undefined) {
        return { credential: 'device', deviceId: device.id, privileged: allowPrivileged }
      }
    }

    const cookie = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (cookie !== undefined) {
      const claims = verifySession(this.store.state.signingKey, cookie, now)
      if (claims !== undefined) {
        return {
          credential: 'session',
          ...claims.subject !== 'password' && { deviceId: claims.subject },
          privileged: allowPrivileged,
        }
      }
    }

    if (this.config.compat.addressGrants) {
      const grant = this.store.state.grants[request.address]
      if (grant !== undefined && now < grant.expiresAt && now >= grant.createdAt) {
        const device = this.store.state.devices[grant.deviceId]
        if (device !== undefined && device.revokedAt === undefined) {
          return { credential: 'address-grant', deviceId: grant.deviceId, privileged: false }
        }
      }
    }

    return { credential: 'none', privileged: false }
  }

  /**
   * Resolve a bearer token to its device.
   * @param token - the token as presented.
   * @param now - current epoch millis.
   * @returns the device, or undefined when the token is unknown, revoked, or expired.
   */
  #deviceForToken(token: string, now: number): DeviceRecord | undefined {
    const deviceId = this.#tokenIndex.get(hashToken(this.store.state.signingKey, token))
    if (deviceId === undefined) return undefined
    const device = this.store.state.devices[deviceId]
    if (device === undefined || device.revokedAt !== undefined) return undefined
    // A clock step backwards would otherwise make an expired token look fresh.
    if (now >= device.expiresAt || now < device.createdAt) return undefined
    return device
  }

  /**
   * Set or replace the sign-in password.
   * @param password - the new plaintext.
   * @returns resolution once the hash is durable.
   */
  async setPassword(password: string): Promise<void> {
    const record = await hashPassword(password)
    await this.store.update((draft) => { draft.password = record })
  }

  /**
   * Verify a sign-in and mint a session cookie.
   * @param password - the plaintext as typed.
   * @param address - normalized source address, for the lockout counter.
   * @param now - current epoch millis.
   * @returns the cookie to set, or the reason the attempt was refused.
   */
  async signIn(password: string, address: string, now: number): Promise<SignInSuccess | SignInFailure> {
    const record = this.store.state.password
    if (record === undefined) return 'no-password'
    if (this.#throttle.lockedUntil(address, now) !== undefined) return 'locked-out'
    if (!await verifyPassword(record, password)) {
      this.#throttle.recordFailure(address, now)
      return 'bad-password'
    }
    this.#throttle.recordSuccess(address)
    const expiresAt = now + this.config.sessionTtlMs
    return {
      cookie: signSession(this.store.state.signingKey, { subject: 'password', issuedAt: now, expiresAt }),
      expiresAt,
    }
  }

  /**
   * Enrol a device against the outstanding pairing code.
   * @param options.code - the code as presented.
   * @param options.name - the device label to record.
   * @param options.address - normalized source address.
   * @param now - current epoch millis.
   * @returns the minted token and its device, or undefined when the code did not match.
   */
  async pair(options: {
    readonly code: string
    readonly name: string
    readonly address: string
  }, now: number): Promise<{ readonly token: string, readonly device: DeviceRecord } | 'locked-out' | undefined> {
    // Distinguished from a refused code on purpose. Both used to answer "that code is not valid",
    // which sends someone to reload the pairing page for a fresh code — the one thing that cannot
    // help while their address is locked out, and which spends another attempt confirming it.
    if (this.#throttle.lockedUntil(options.address, now) !== undefined) return 'locked-out'
    if (!this.pairing.claim(options.code, now)) {
      this.#throttle.recordFailure(options.address, now)
      return undefined
    }
    this.#throttle.recordSuccess(options.address)
    const token = mintToken()
    const device: DeviceRecord = {
      id: mintDeviceId(),
      name: options.name.slice(0, 64) || 'device',
      tokenHash: hashToken(this.store.state.signingKey, token),
      createdAt: now,
      expiresAt: now + this.config.deviceTokenTtlMs,
      lastAddress: options.address,
    }
    await this.store.update((draft) => {
      draft.devices[device.id] = device
      // The grant is what lets a client that cannot send a credential at all
      // reach the harness. It is refused outside private ranges, because a
      // public address is shared with everyone behind the same carrier NAT.
      if (this.config.compat.addressGrants && isPrivateAddress(options.address)) {
        draft.grants[options.address] = {
          address: options.address,
          deviceId: device.id,
          createdAt: now,
          expiresAt: now + this.config.compat.addressGrantTtlMs,
        }
      }
    })
    this.#reindex()
    return { token, device }
  }

  /**
   * Refresh a device's grant after an accepted request from a new address.
   * @param deviceId - the device.
   * @param address - normalized source address.
   * @param now - current epoch millis.
   * @returns resolution once the record is durable.
   */
  async touch(deviceId: string, address: string, now: number): Promise<void> {
    const device = this.store.state.devices[deviceId]
    if (device === undefined) return
    if (device.lastAddress === address && (device.lastSeenAt ?? 0) > now - 60_000) return
    await this.store.update((draft) => {
      const record = draft.devices[deviceId]
      if (record === undefined) return
      record.lastSeenAt = now
      record.lastAddress = address
      if (this.config.compat.addressGrants && isPrivateAddress(address)) {
        draft.grants[address] = {
          address,
          deviceId,
          createdAt: now,
          expiresAt: now + this.config.compat.addressGrantTtlMs,
        }
      }
    })
  }

  /**
   * Revoke one device and every grant it created.
   * @param deviceId - the device to revoke.
   * @param now - current epoch millis.
   * @returns true when a live device was revoked.
   */
  async revoke(deviceId: string, now: number): Promise<boolean> {
    const device = this.store.state.devices[deviceId]
    if (device === undefined || device.revokedAt !== undefined) return false
    await this.store.update((draft) => {
      const record = draft.devices[deviceId]
      if (record !== undefined) record.revokedAt = now
      for (const [address, grant] of Object.entries(draft.grants)) {
        if (grant.deviceId === deviceId) delete draft.grants[address]
      }
    })
    this.#reindex()
    return true
  }

  /**
   * Rotate the signing key, invalidating every cookie and every device token.
   *
   * Device records are dropped rather than kept with dead hashes: a token hash
   * is keyed by the signing key, so after rotation none of them could ever
   * match again and leaving them would only misreport what is enrolled.
   * @returns resolution once the new key is durable.
   */
  async signOutEverywhere(): Promise<void> {
    const { randomBytes } = await import('node:crypto')
    await this.store.update((draft) => {
      draft.signingKey = randomBytes(32).toString('base64url')
      draft.devices = {}
      draft.grants = {}
    })
    this.#reindex()
    this.pairing.clear()
  }

  /** Stop the throttle sweep. */
  dispose(): void {
    this.#throttle.dispose()
    this.pairing.clear()
  }
}
