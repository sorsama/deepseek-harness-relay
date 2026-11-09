/**
 * Durable relay state: the signing key, the sign-in password hash, enrolled
 * devices, and IP grants.
 *
 * This deliberately does NOT use `ctx.storageDomain`. Everything here is a
 * secret or a credential, and the domain layer's json backend publishes
 * world-readable files under a shared directory; the relay owns one file it
 * creates at mode 0600 instead. It also keeps the plugin free of a zod
 * dependency and of a version pin on the storage packages, so one plugin build
 * runs against any harness that still has the services it injects.
 *
 * Writes are atomic (temp file plus rename) and serialized on one chain, so a
 * crash mid-write leaves the previous state intact and two concurrent grants
 * cannot lose each other.
 * @module dsh-relay/state
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * On-disk format version; a file stamped with anything else is refused.
 *
 * 2 adds `peers`: relays this machine has linked with as another computer.
 * A 1 file is upgraded on open, in place, keeping devices, grants, and the
 * certificate, so an install that predates computer linking keeps working.
 */
const STATE_VERSION = 2 as const

/** File name under the relay state directory. */
const STATE_FILE = 'state.json'

/** Owner-only permissions for every file this module writes. */
const SECRET_MODE = 0o600

/** One enrolled device. The bearer token itself is never stored — only its hash. */
export interface DeviceRecord {
  /** Opaque device id, also the revocation handle. */
  readonly id: string
  /** Human label chosen at pairing time. */
  name: string
  /** SHA-256 of the issued bearer token, hex. */
  readonly tokenHash: string
  /** Epoch millis the device was enrolled. */
  readonly createdAt: number
  /** Epoch millis the token stops being accepted. */
  expiresAt: number
  /** Epoch millis of the last accepted request, absent until the first one. */
  lastSeenAt?: number
  /** Source address of the last accepted request. */
  lastAddress?: string
  /** Set when the owner revoked this device; the record is kept for the audit trail. */
  revokedAt?: number
}

/**
 * A source address temporarily accepted without a credential.
 *
 * This exists for DSH Mobile 0.5.0, which sends no `Authorization` header and
 * therefore cannot present a token at all. It is materially weaker than a
 * token and is scoped accordingly: private addresses only, short TTL, and
 * revocable with the device that created it.
 */
export interface AddressGrant {
  /** Normalized source address this grant admits. */
  readonly address: string
  /** Device whose pairing created the grant; revoking that device drops it. */
  readonly deviceId: string
  /** Epoch millis the grant was created. */
  readonly createdAt: number
  /** Epoch millis the grant stops being accepted. */
  readonly expiresAt: number
}

/**
 * One linked computer: another relay this machine pairs with as a peer.
 *
 * Two tokens keep one link alive, one per direction. The peer holds the token
 * it uses to call this relay, of which only {@link inboundTokenHash} is kept
 * here. This relay holds the token it uses to call the peer, in plaintext,
 * because it must present it; the state file is owner-only for that reason,
 * exactly like the signing key beside it.
 */
export interface PeerRecord {
  /** Local id, also the unlink handle. */
  readonly id: string
  /** Id both sides recorded for this link, so a log line names the same pair. */
  readonly linkId: string
  /** The other computer's name, as it introduced itself. */
  name: string
  /** Origin of the other relay: `https://host:port`, never loopback. */
  readonly url: string
  /**
   * SPKI fingerprint of the other relay's certificate, base64 SHA-256.
   *
   * Every call to the peer is checked against this, so a changed certificate
   * ends the link instead of quietly trusting a new key.
   */
  readonly fingerprint: string
  /** Keyed hash of the token the peer presents to this relay. */
  readonly inboundTokenHash: string
  /** Token this relay presents to the peer. */
  readonly outboundToken: string
  /** Epoch millis the link was made. */
  readonly createdAt: number
  /** Epoch millis this relay last reached the peer, or the peer reached it. */
  lastSeenAt?: number
  /** Source address of the peer's last call, when it called this relay. */
  lastAddress?: string
}

/** The password sign-in credential, stored as a salted scrypt hash. */
export interface PasswordRecord {
  /** Per-install salt, hex. */
  readonly salt: string
  /** scrypt output, hex. */
  readonly hash: string
  /** scrypt cost parameter, recorded so a later default change stays verifiable. */
  readonly cost: number
  /** Epoch millis the password was last set. */
  readonly updatedAt: number
}

/** Paths and identity of the certificate currently in use. */
export interface CertificateRecord {
  /** SHA-256 of the DER SubjectPublicKeyInfo, base64 — what a pinning client compares. */
  readonly fingerprint: string
  /** Subject alternative names the certificate was generated for. */
  readonly sans: readonly string[]
  /** Epoch millis of generation. */
  readonly generatedAt: number
  /** Epoch millis the certificate expires. */
  readonly expiresAt: number
}

/** Everything the relay persists between runs. */
export interface RelayState {
  readonly version: typeof STATE_VERSION
  /** HMAC key for session cookies and pairing codes, base64url. Rotating it signs everyone out. */
  signingKey: string
  password?: PasswordRecord
  devices: Record<string, DeviceRecord>
  grants: Record<string, AddressGrant>
  /** Linked computers, newest first on read. Absent in a v1 file until upgraded. */
  peers: Record<string, PeerRecord>
  certificate?: CertificateRecord
}

/** A fresh state with a new signing key and nothing enrolled. */
function emptyState(): RelayState {
  return {
    version: STATE_VERSION,
    signingKey: randomBytes(32).toString('base64url'),
    devices: {},
    grants: {},
    peers: {},
  }
}

/** Serialize and atomically replace the state file. */
async function writeStateFile(file: string, state: RelayState): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: SECRET_MODE })
  await rename(temp, file)
}

/**
 * The relay's state file.
 *
 * Reads are synchronous against the in-memory copy loaded at open. Every
 * mutation goes through {@link update}, which applies the change in memory and
 * persists the whole file before resolving, so an awaited mutation is durable.
 */
export class RelayStore {
  #state: RelayState
  #chain: Promise<void> = Promise.resolve()
  #closed = false

  private constructor(private readonly file: string, state: RelayState) {
    this.#state = state
  }

  /**
   * Load the state file, creating it when absent.
   * @param dir - the relay state directory; created with owner-only permissions.
   * @returns the open store.
   * @throws {Error} when the file exists but is unparsable or carries another format version — a
   * corrupt credential store must fail loud rather than silently reset to "no password set".
   */
  static async open(dir: string): Promise<RelayStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, STATE_FILE)
    let state: RelayState
    try {
      const raw = await readFile(file, 'utf8')
      // Read through a shape with a numeric version, so both the v1 upgrade
      // and the version check are reachable in the type system.
      const parsed = JSON.parse(raw) as {
        readonly version: number
        readonly signingKey?: string
        readonly password?: PasswordRecord
        readonly devices?: Record<string, DeviceRecord>
        readonly grants?: Record<string, AddressGrant>
        readonly peers?: Record<string, PeerRecord>
        readonly certificate?: CertificateRecord
      }
      if (parsed.version !== 1 && parsed.version !== STATE_VERSION) {
        throw new Error(`dsh-relay: ${file} has format version ${String(parsed.version)}, expected ${String(STATE_VERSION)}`)
      }
      if (typeof parsed.signingKey !== 'string') {
        throw new Error(`dsh-relay: ${file} has no signing key, so it is not a relay state file`)
      }
      if (parsed.version === 1) {
        // Upgrade in place before serving a request. Devices, grants, and the
        // certificate carry over untouched; a phone paired before this release
        // stays paired, and its token keeps verifying.
        state = {
          version: STATE_VERSION,
          signingKey: parsed.signingKey,
          devices: parsed.devices ?? {},
          grants: parsed.grants ?? {},
          peers: {},
          ...parsed.password === undefined ? {} : { password: parsed.password },
          ...parsed.certificate === undefined ? {} : { certificate: parsed.certificate },
        }
        await writeStateFile(file, state)
      } else {
        state = {
          version: STATE_VERSION,
          signingKey: parsed.signingKey,
          devices: parsed.devices ?? {},
          grants: parsed.grants ?? {},
          peers: parsed.peers ?? {},
          ...parsed.password === undefined ? {} : { password: parsed.password },
          ...parsed.certificate === undefined ? {} : { certificate: parsed.certificate },
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = emptyState()
      await writeStateFile(file, state)
    }
    return new RelayStore(file, state)
  }

  /**
   * Current state, synchronously from memory.
   * @returns the live state object; treat it as read-only and mutate through {@link update}.
   */
  get state(): Readonly<RelayState> {
    return this.#state
  }

  /**
   * Apply one mutation and persist the result.
   * @param mutate - synchronous transform over a draft copy of the state.
   * @returns resolution after the new state is on disk.
   */
  async update(mutate: (draft: RelayState) => void): Promise<void> {
    const task = this.#chain.then(async () => {
      if (this.#closed) throw new Error('dsh-relay: state store is closed')
      const draft = structuredClone(this.#state) as RelayState
      mutate(draft)
      await writeStateFile(this.file, draft)
      this.#state = draft
    })
    // Keep the chain alive after a rejection so one failed write does not wedge
    // every later one; the caller still sees its own rejection.
    this.#chain = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * Drain queued writes and refuse further ones.
   * @returns resolution after the last queued write has landed.
   */
  async close(): Promise<void> {
    const drained = this.#chain
    this.#closed = true
    await drained
  }
}
