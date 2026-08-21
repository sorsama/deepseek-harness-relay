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

/** On-disk format version; a file stamped with anything else is refused. */
const STATE_VERSION = 1 as const

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
  certificate?: CertificateRecord
}

/** A fresh state with a new signing key and nothing enrolled. */
function emptyState(): RelayState {
  return {
    version: STATE_VERSION,
    signingKey: randomBytes(32).toString('base64url'),
    devices: {},
    grants: {},
  }
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
      const parsed = JSON.parse(raw) as RelayState
      if (parsed.version !== STATE_VERSION) {
        throw new Error(`dsh-relay: ${file} has format version ${String(parsed.version)}, expected ${String(STATE_VERSION)}`)
      }
      state = { ...parsed, devices: parsed.devices ?? {}, grants: parsed.grants ?? {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      state = emptyState()
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: SECRET_MODE })
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
      const temp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temp, `${JSON.stringify(draft, null, 2)}\n`, { mode: SECRET_MODE })
      await rename(temp, this.file)
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
