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
import type { DeviceRecord, PeerRecord, RelayStore } from '../state.ts'
import { isGrantableAddress } from '../fence.ts'
import { hashPassword, verifyPassword } from './password.ts'
import { PairingWindow } from './pairing.ts'
import { Throttle } from './ratelimit.ts'
import {
  hashToken,
  mintDeviceId,
  mintLinkId,
  mintToken,
  readBearer,
  readCookie,
  signSession,
  verifySession,
} from './tokens.ts'

/** Name of the signed sign-in cookie. */
export const SESSION_COOKIE = 'dsh_relay_session'

/**
 * Headers a forwarding proxy stamps on the traffic it relays.
 *
 * Funnel, Serve, and Caddy always add `X-Forwarded-For`; nginx does in any
 * configuration written from its own documentation. A browser never sends any
 * of these on its own, so a false positive costs one sign-in, while a false
 * negative seats the internet in the operator's chair.
 */
const FORWARDING_TELLS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'] as const

/**
 * Whether a request visibly came through a forwarding proxy.
 * @param headers - the inbound request headers.
 * @returns true when any forwarding header is present.
 */
export function isForwarded(headers: IncomingHttpHeaders): boolean {
  return FORWARDING_TELLS.some(name => headers[name] !== undefined)
}

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
  /** token hash → peer id, for tokens another relay presents to this one. */
  #peerIndex = new Map<string, string>()
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

  /** Rebuild the token lookup indexes from durable state. */
  #reindex(): void {
    const index = new Map<string, string>()
    for (const device of Object.values(this.store.state.devices)) {
      if (device.revokedAt !== undefined) continue
      index.set(device.tokenHash, device.id)
    }
    this.#tokenIndex = index
    const peers = new Map<string, string>()
    for (const peer of Object.values(this.store.state.peers)) {
      peers.set(peer.inboundTokenHash, peer.id)
    }
    this.#peerIndex = peers
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

  /** Linked computers, newest first. */
  get peers(): PeerRecord[] {
    return Object.values(this.store.state.peers)
      .toSorted((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Resolve a bearer token to a linked computer.
   *
   * This is a link-scoped credential, not a harness credential: it is accepted
   * only by the peer endpoints, never by the proxy or the operator routes.
   * @param token - the token as presented.
   * @returns the peer, or undefined when the token is unknown or the link is gone.
   */
  peerForToken(token: string): PeerRecord | undefined {
    const peerId = this.#peerIndex.get(hashToken(this.store.state.signingKey, token))
    if (peerId === undefined) return undefined
    return this.store.state.peers[peerId]
  }

  /**
   * Resolve the linked computer behind an `Authorization: Bearer` header.
   * @param headers - the inbound request headers.
   * @returns the peer, or undefined when no valid link token was presented.
   */
  identifyPeer(headers: AuthRequest['headers']): PeerRecord | undefined {
    const token = readBearer(headers.authorization)
    return token === undefined ? undefined : this.peerForToken(token)
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
    // Loopback is the operator only when the request originated there too. A
    // reverse proxy on this machine connects from 127.0.0.1 on behalf of
    // anyone who can reach it, and the forwarding headers it adds are the
    // visible difference from the operator's own browser. A forwarded request
    // falls through to the credential checks — a proxied client presenting a
    // real token is still that device.
    if (request.local && !isForwarded(request.headers)) return { credential: 'loopback', privileged: true }

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

    // A grant recorded before the relay refused loopback and this machine's
    // own addresses must not keep admitting what it no longer would issue.
    if (this.config.compat.addressGrants && isGrantableAddress(request.address)) {
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
   * Mint a browser session without a password.
   *
   * Only the cross-PC open handoff calls this, after the request proved it is
   * a linked computer presenting its link token. The result is the same
   * password-subject session a sign-in would produce, so the harness and the
   * relay treat it identically from then on.
   * @param now - current epoch millis.
   * @returns the cookie to set and when it expires.
   */
  sessionGrant(now: number): SignInSuccess {
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
      // public address is shared with everyone behind the same carrier NAT,
      // and on loopback or this machine's own addresses, which stand for
      // every client of a local proxy or every container on the host.
      if (this.config.compat.addressGrants && isGrantableAddress(options.address)) {
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
   * Accept a computer link claimed with the outstanding pairing code.
   *
   * The caller is another relay's operator, holding a code this machine issued.
   * It hands over the token it will accept calls on (`callbackToken`); this
   * relay mints the token the peer presents here and returns it. Success
   * consumes the code, exactly like device pairing.
   * @param options.code - the code as presented.
   * @param options.name - the peer's label.
   * @param options.url - the peer's reachable origin, already validated as https.
   * @param options.fingerprint - the peer's certificate pin, already validated.
   * @param options.callbackToken - token this relay will present to the peer.
   * @param options.address - normalized source address, for the lockout counter.
   * @param now - current epoch millis.
   * @returns the recorded peer and the token its operator must keep, or the reason it failed.
   */
  async pairComputer(options: {
    readonly code: string
    readonly name: string
    readonly url: string
    readonly fingerprint: string
    readonly callbackToken: string
    readonly address: string
  }, now: number): Promise<{ readonly peer: PeerRecord, readonly token: string } | 'locked-out' | undefined> {
    if (this.#throttle.lockedUntil(options.address, now) !== undefined) return 'locked-out'
    if (!this.pairing.claim(options.code, now)) {
      this.#throttle.recordFailure(options.address, now)
      return undefined
    }
    this.#throttle.recordSuccess(options.address)
    const inboundToken = mintToken()
    const peer: PeerRecord = {
      id: mintDeviceId(),
      linkId: mintLinkId(),
      name: options.name.slice(0, 64) || 'PC',
      url: options.url,
      fingerprint: options.fingerprint,
      inboundTokenHash: hashToken(this.store.state.signingKey, inboundToken),
      outboundToken: options.callbackToken,
      createdAt: now,
      lastAddress: options.address,
    }
    await this.store.update((draft) => { draft.peers[peer.id] = peer })
    this.#reindex()
    return { peer, token: inboundToken }
  }

  /**
   * Record a link this relay initiated, after the peer accepted it.
   * @param input - names and tokens already exchanged with the peer.
   * @param now - current epoch millis.
   * @returns the recorded peer.
   */
  async recordPeer(input: {
    readonly name: string
    readonly url: string
    readonly fingerprint: string
    readonly linkId: string
    readonly inboundToken: string
    readonly outboundToken: string
    readonly address: string
  }, now: number): Promise<PeerRecord> {
    const peer: PeerRecord = {
      id: mintDeviceId(),
      linkId: input.linkId,
      name: input.name.slice(0, 64) || 'PC',
      url: input.url,
      fingerprint: input.fingerprint,
      inboundTokenHash: hashToken(this.store.state.signingKey, input.inboundToken),
      outboundToken: input.outboundToken,
      createdAt: now,
      lastAddress: input.address,
    }
    await this.store.update((draft) => { draft.peers[peer.id] = peer })
    this.#reindex()
    return peer
  }

  /**
   * Drop one link, on this side only. The peer learns on its next call, which
   * stops authenticating, and shows the link as gone.
   * @param peerId - the peer to unlink.
   * @returns true when a link was removed.
   */
  async removePeer(peerId: string): Promise<boolean> {
    if (this.store.state.peers[peerId] === undefined) return false
    await this.store.update((draft) => { delete draft.peers[peerId] })
    this.#reindex()
    return true
  }

  /**
   * Record that a peer was reachable, from either direction.
   * @param peerId - the peer.
   * @param address - source address of its call, when it called this relay.
   * @param now - current epoch millis.
   * @returns resolution once the record is durable.
   */
  async touchPeer(peerId: string, address: string | undefined, now: number): Promise<void> {
    const peer = this.store.state.peers[peerId]
    if (peer === undefined) return
    const fresh = (peer.lastSeenAt ?? 0) > now - 60_000 && (address === undefined || peer.lastAddress === address)
    if (fresh) return
    await this.store.update((draft) => {
      const record = draft.peers[peerId]
      if (record === undefined) return
      record.lastSeenAt = now
      if (address !== undefined) record.lastAddress = address
    })
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
      if (this.config.compat.addressGrants && isGrantableAddress(address)) {
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
      // Peer tokens are keyed by the same signing key, so they can never match
      // again; the links themselves are dropped too, because a half-dead link
      // that still shows a row and an Open button is worse than none.
      draft.peers = {}
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
