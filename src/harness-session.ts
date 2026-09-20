/**
 * The harness browser session the relay presents upstream.
 *
 * From harness 0.1.2 the harness authenticates its complete `/api` surface —
 * every Remote call, the `/api/remote.mux` upgrade, and the session-log
 * download — against a signed, authority-bound cookie, and answers 401 without
 * one. The relay strips the client's own `Cookie` before forwarding (that
 * header authenticates the phone to the *relay* and means nothing upstream),
 * so without a session of its own every proxied request is refused.
 *
 * The relay cannot obtain one the way a browser does: the launch token is
 * printed once per harness process, is only accepted on the index route, and is
 * never persisted. What it can do is what the harness itself does — read the
 * durable signing secret from the credential store it shares and mint a cookie
 * directly. That is not a bypass. The relay already runs inside the harness
 * process with the operator's authority; a plugin that can read `ctx.credentials`
 * could call any harness API in-process without a cookie at all. Minting one
 * only lets it speak the same HTTP contract as the browser.
 *
 * @module dsh-relay/harness-session
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** Where `dsh-client-connection` keeps its cookie-signing secret. */
const RECORD_KEY = 'client-connection/browser-session'

/** Cookie-name prefix, before the hashed authority. */
const COOKIE_PREFIX = 'dsh-auth-'

/** Payload version the harness accepts. */
const COOKIE_PAYLOAD_VERSION = 1

/** Stored-secret envelope version the harness writes. */
const STORED_SECRET_VERSION = 1

/** Length of the signing secret, in bytes. */
const SECRET_BYTES = 32

/**
 * How long a minted cookie claims to be valid.
 *
 * Deliberately short. The harness rejects a cookie whose lifetime exceeds its
 * own configured `cookieMaxAgeDays`, and the relay has no way to read that
 * setting — so anything longer than the smallest plausible configuration would
 * be refused on some deployments and not others. A cookie is minted per
 * request and never travels further than loopback, so it needs no life at all
 * beyond the request it rides.
 */
const LIFETIME_MS = 60_000

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode the stored secret, or undefined when the record is not one this
 * version understands.
 *
 * A record in an unexpected shape is not repaired or replaced: the harness owns
 * that file, and a relay that rewrote it could invalidate every browser session
 * on the machine. Failing to mint is the safe direction — it costs remote
 * access until the operator restarts, where guessing could cost the operator
 * their own logged-in browser.
 */
function readSecret(record: unknown): Buffer | undefined {
  if (!isRecord(record) || record.kind !== 'grant' || !isRecord(record.payload)) return undefined
  if (record.payload.version !== STORED_SECRET_VERSION) return undefined
  const secret = record.payload.secret
  if (typeof secret !== 'string') return undefined
  const decoded = Buffer.from(secret.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  return decoded.byteLength === SECRET_BYTES ? decoded : undefined
}

/**
 * The cookie name for one authority.
 *
 * Authority-scoped by design upstream, so one harness home can serve several
 * web ports without their cookies colliding. The relay must therefore name the
 * authority it actually forwards to — the loopback one it rewrites `Host` to —
 * not the edge address the client reached it on.
 */
function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Mints harness browser-session cookies for proxied requests. */
export class HarnessSession {
  private constructor(private readonly secret: Buffer) {}

  /**
   * Load the harness's cookie-signing secret.
   *
   * @param ctx - plugin context; `ctx.credentials` is the harness's own store.
   * @returns a minter, or undefined when this harness keeps no such secret —
   *   which is every release before 0.1.2, where nothing needed one.
   */
  static async load(ctx: Context): Promise<HarnessSession | undefined> {
    const credentials = ctx.get('credentials') as undefined | {
      readRecord?: (key: string) => Promise<unknown>
    }
    if (credentials?.readRecord === undefined) return undefined
    const record = await credentials.readRecord(RECORD_KEY).catch(() => undefined)
    const secret = readSecret(record)
    return secret === undefined ? undefined : new HarnessSession(secret)
  }

  /**
   * A minter backed by a secret of the caller's choosing. Tests only.
   * @param secret - a 32-byte signing secret.
   * @returns a minter over that secret.
   */
  static forTesting(secret: Buffer = randomBytes(SECRET_BYTES)): HarnessSession {
    return new HarnessSession(secret)
  }

  /**
   * The `Cookie` header value proving a browser session for [authority].
   * @param authority - the upstream `host:port` this request will carry.
   * @returns one `name=value` pair, ready to send as `Cookie`.
   */
  cookieFor(authority: string): string {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + LIFETIME_MS
    const body = encodeBase64Url(Buffer.from(JSON.stringify({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }), 'utf8'))
    const signature = encodeBase64Url(createHmac('sha256', this.secret).update(body).digest())
    return `${cookieName(authority)}=v1.${body}.${signature}`
  }
}

/** Supplies the harness browser session a forwarded request presents. */
export interface HarnessSessionSource {
  /**
   * The `Cookie` header value for [authority], or undefined while no secret
   * exists. A source that has not loaded one loads it here rather than making
   * the caller wait for a reload.
   * @param authority - the upstream `host:port` this request will carry.
   * @returns one `name=value` pair, or undefined when unauthenticated.
   */
  cookieFor(authority: string): Promise<string | undefined>
}

/**
 * The relay's live handle on the harness browser session.
 *
 * The secret can appear after this plugin applies: the credential service may
 * activate later, and on a harness home that never served the web profile the
 * Connection that mints the record has not run yet. The session is therefore
 * resolved from the request path instead of read once at startup, so the first
 * request after the secret exists already carries it and no reload or retry
 * cycle is needed.
 */
export class HarnessSessionProvider implements HarnessSessionSource {
  #session: HarnessSession | undefined

  /**
   * @param ctx - plugin context; `ctx.credentials` is the harness's own store.
   * @param onAvailable - called once, when the secret first loads.
   */
  constructor(private readonly ctx: Context, private readonly onAvailable: () => void = () => {}) {}

  /** Whether a loaded session authenticates every forwarded request. */
  get available(): boolean {
    return this.#session !== undefined
  }

  /**
   * Load the secret if it exists now.
   * @returns true once a session is loaded.
   */
  async refresh(): Promise<boolean> {
    const found = this.#session ?? await HarnessSession.load(this.ctx)
    if (this.#session === undefined && found !== undefined) {
      this.#session = found
      this.onAvailable()
    }
    return this.#session !== undefined
  }

  /**
   * The `Cookie` header value for [authority], loading the secret when it is
   * not loaded yet.
   * @param authority - the upstream `host:port` this request will carry.
   * @returns one `name=value` pair, or undefined when unauthenticated.
   */
  async cookieFor(authority: string): Promise<string | undefined> {
    if (this.#session === undefined) await this.refresh()
    return this.#session?.cookieFor(authority)
  }
}
