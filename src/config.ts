/**
 * The relay's configuration surface.
 *
 * Every value two deployments could reasonably want set differently is a field
 * here, per the harness's "no hardcoded tunables" rule: the test is whether
 * `cordis.yml` can change it without a code edit. Protocol constants and
 * security invariants stay fixed in code.
 * @module dsh-relay/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** How the primary listener presents itself on the wire. */
export type TlsMode = 'self-signed' | 'files' | 'off'

/**
 * Which credential classes the relay accepts.
 *
 * `password` is a browser sign-in; `device-token` is the bearer credential a
 * paired client presents. Both may be on at once.
 */
export type AuthMode = 'password' | 'device-token' | 'both'

/** Whether an authenticated remote client reaches the harness configuration plane. */
export type PrivilegedPolicy = 'allow-authenticated' | 'loopback-only'

/** Compatibility settings for clients that cannot present a credential. */
export interface CompatConfig {
  /**
   * Accept requests from a source address a paired device was last seen on.
   *
   * This exists only for DSH Mobile 0.5.0, which sends no `Authorization`
   * header, no cookies, and no `Origin`, so it has no way to present a
   * credential at all. A source address is NOT authentication: it is shared
   * behind NAT, reassigned by DHCP, rotated by IPv6 privacy extensions, and
   * spoofable on the same layer-2 segment. Grants are therefore refused for
   * non-private addresses, expire on a short TTL, die with the device that
   * created them, and never reach the privileged method set.
   */
  addressGrants: boolean
  /** Lifetime of one address grant. */
  addressGrantTtlMs: number
  /**
   * Extra plain-HTTP listener port for clients that cannot speak TLS.
   *
   * DSH Mobile 0.5.0 hardcodes `http://` for both its RPC calls and its two
   * WebSocket downlinks, so a TLS-only relay is unreachable by it. Zero
   * disables the listener.
   *
   * It accepts a bearer token as readily as an address grant, so it stays
   * useful once grants are off — for a client that holds a credential but
   * cannot pin a certificate. What it never carries is a password session: a
   * sign-in cookie must not cross an unencrypted hop. The token does travel in
   * the clear on it, which is the operator's call to make, the same as `tls:
   * off`.
   */
  plainPort: number
}

/** Resolved plugin configuration. */
export interface Config {
  /** Listen address of the primary listener. */
  bind: string
  /** Listen port of the primary listener; zero requests an OS-assigned port. */
  port: number
  /** Directory holding the state file, certificate, and key; supplied by the bundle patch. */
  stateDir: string
  /** Authorities this relay is reached by, beyond its own bind-derived literals. */
  trustedHosts: string[]
  /** Extra certificate SANs and QR authorities for a port-forwarded deployment. */
  publicHostnames: string[]
  /** Transport posture of the primary listener. */
  tls: TlsMode
  /** Certificate path, required when `tls` is `files`. */
  tlsCertPath: string
  /** Private key path, required when `tls` is `files`. */
  tlsKeyPath: string
  /** Credential classes accepted. */
  auth: AuthMode
  /** Lifetime of a browser sign-in cookie. */
  sessionTtlMs: number
  /** Lifetime of a device bearer token. */
  deviceTokenTtlMs: number
  /** How long one pairing code stays claimable. */
  pairingWindowMs: number
  /** Digits in a numeric pairing passcode. */
  pairingCodeLength: number
  /** Failed sign-ins from one address before it is locked out. */
  maxFailedAttempts: number
  /** Lockout duration after `maxFailedAttempts`. */
  lockoutMs: number
  /** Requests per minute per source address, across every path. */
  rateLimitPerMinute: number
  /**
   * Whether an authenticated remote client reaches the methods the harness
   * pins to loopback (settings, credentials, model discovery, host pickers,
   * agent-preset authoring). Address-granted clients never reach them
   * regardless of this setting.
   */
  privilegedMethods: PrivilegedPolicy
  /** Path prefixes proxied beyond the built-in set; each must start with `/`. */
  extraProxyPaths: string[]
  /** Upstream response deadline for a proxied request. */
  proxyTimeoutMs: number
  compat: CompatConfig
  /**
   * Add a link to the relay's own pages into the harness web UI.
   *
   * The relay ships no browser plugin, so without this its pairing, device,
   * and password pages are reachable only by typing a path.
   */
  uiLink: boolean
  /** Advertise `_dsh._tcp` over mDNS. */
  mdns: boolean
  /** Service name used in the mDNS advertisement; empty derives one from the hostname. */
  mdnsName: string
}

/**
 * The `compat` block as the **schema** sees it.
 *
 * Volatility is applied per leaf, so a nested object resolves to an object of
 * handles rather than to one handle over the object: `compat.addressGrants` is
 * a `Volatile<boolean>`, not `compat` being a `Volatile<CompatConfig>`.
 */
export interface CompatSchema {
  compat: {
    addressGrants: Volatile<boolean>
    addressGrantTtlMs: Volatile<number>
    plainPort: Volatile<number>
  }
}

/**
 * The schema's own view of the configuration.
 *
 * A `.volatile()` field does not resolve to its plain value: cordis replaces it
 * with a **live handle** (`{ get(): T }`) so that a settings edit reaches the
 * running plugin without a remount. That makes the schema's inferred type
 * genuinely different from the {@link Config} the rest of this plugin consumes,
 * so the two are declared separately and the plugin reads plain values.
 *
 * `stateDir` is the one field without a handle. It is not on the form: the
 * bundle patch derives it from `dshHomePath('relay')`, and an editable absolute
 * path in a browser form is a way to have the relay write its state somewhere
 * unexpected.
 */
export interface ConfigSchema {
  bind: Volatile<string>
  port: Volatile<number>
  stateDir: string
  trustedHosts: Volatile<string[]>
  publicHostnames: Volatile<string[]>
  tls: Volatile<TlsMode>
  tlsCertPath: Volatile<string>
  tlsKeyPath: Volatile<string>
  auth: Volatile<AuthMode>
  sessionTtlMs: Volatile<number>
  deviceTokenTtlMs: Volatile<number>
  pairingWindowMs: Volatile<number>
  pairingCodeLength: Volatile<number>
  maxFailedAttempts: Volatile<number>
  lockoutMs: Volatile<number>
  rateLimitPerMinute: Volatile<number>
  privilegedMethods: Volatile<PrivilegedPolicy>
  extraProxyPaths: Volatile<string[]>
  proxyTimeoutMs: Volatile<number>
  compat: CompatSchema['compat']
  uiLink: Volatile<boolean>
  mdns: Volatile<boolean>
  mdnsName: Volatile<string>
}

/**
 * The settings form's fields, and the reason each one carries `.volatile()`.
 *
 * On dsh 0.1.7 the Plugins page builds an entry's form with `volatileForm()`,
 * which keeps **only** the fields whose nearest marked ancestor is volatile and
 * returns `undefined` for a schema with none. `describe()` then drops any entry
 * whose form came back `undefined`, so a schema with no `.volatile()` is a
 * schema with no settings page at all — not an empty one, an absent one.
 *
 * `.volatile()` also makes the resolved value a **live handle** rather than a
 * copy, which is why {@link plainConfig} reads through them on every use.
 *
 * The annotation is deliberately `z<ConfigSchema>` rather than left to
 * inference: the inferred type is schemastery's internal `ObjectS`/`ObjectT`
 * pair, which cannot be written down, and the two types it must line up with —
 * `Config` for plugin code and `ConfigSchema` for the handles — are already
 * declared. `@deepseek-ai/dsh-agent-default-model` reaches the same place by
 * inferring throughout, which only works because it never needs the plain type.
 */
export const Config = z.object({
  bind: z.string().default('0.0.0.0')
    .description('Listen address of the primary (TLS) listener.')
    .volatile(),
  port: z.natural().max(65535).default(3443)
    .description('Listen port of the primary listener.')
    .volatile(),
  stateDir: z.string().required(),
  trustedHosts: z.array(String).default([])
    .description('Extra authorities this relay answers to, beyond those derived from its bind.')
    .volatile(),
  publicHostnames: z.array(String).default([])
    .description('Extra certificate names and pairing authorities, for a port-forwarded deployment.')
    .volatile(),
  tls: z.union(['self-signed', 'files', 'off'] as const).default('self-signed')
    .description('Transport posture of the primary listener.')
    .volatile(),
  tlsCertPath: z.string().default('')
    .description('Certificate path, required when tls is "files".')
    .volatile(),
  tlsKeyPath: z.string().default('')
    .description('Private key path, required when tls is "files".')
    .volatile(),
  auth: z.union(['password', 'device-token', 'both'] as const).default('both')
    .description('Credential classes the relay accepts.')
    .volatile(),
  sessionTtlMs: z.natural().min(60_000).default(43_200_000)
    .description('Lifetime of a browser sign-in cookie, in milliseconds.')
    .volatile(),
  deviceTokenTtlMs: z.natural().min(60_000).default(2_592_000_000)
    .description('Lifetime of a paired device token, in milliseconds.')
    .volatile(),
  pairingWindowMs: z.natural().min(10_000).default(300_000)
    .description('How long a pairing code stays claimable, in milliseconds.')
    .volatile(),
  pairingCodeLength: z.natural().min(6).max(12).default(8)
    .description('Digits in a numeric pairing passcode.')
    .volatile(),
  maxFailedAttempts: z.natural().min(1).default(5)
    .description('Failed sign-ins from one address before it is locked out.')
    .volatile(),
  lockoutMs: z.natural().min(1_000).default(900_000)
    .description('Lockout duration after maxFailedAttempts, in milliseconds.')
    .volatile(),
  rateLimitPerMinute: z.natural().min(1).default(600)
    .description('Requests per minute per source address, across every path.')
    .volatile(),
  privilegedMethods: z.union(['allow-authenticated', 'loopback-only'] as const).default('allow-authenticated')
    .description('Whether an authenticated remote client reaches the harness configuration plane.')
    .volatile(),
  extraProxyPaths: z.array(String).default([])
    .description('Path prefixes proxied beyond the built-in set; each must start with "/".')
    .volatile(),
  proxyTimeoutMs: z.natural().min(1_000).default(120_000)
    .description('Upstream response deadline for a proxied request, in milliseconds.')
    .volatile(),
  compat: z.object({
    addressGrants: z.boolean().default(true)
      .description('Accept requests from an address a paired device was last seen on. Not authentication.')
      .volatile(),
    addressGrantTtlMs: z.natural().min(60_000).default(86_400_000)
      .description('Lifetime of one address grant, in milliseconds.')
      .volatile(),
    plainPort: z.natural().max(65535).default(0)
      .description('Extra plain-HTTP listener port for clients that cannot speak TLS. Zero disables it.')
      .volatile(),
  }),
  uiLink: z.boolean().default(true)
    .description('Add a link to the relay pages into the harness web UI.')
    .volatile(),
  mdns: z.boolean().default(true)
    .description('Advertise _dsh._tcp over mDNS.')
    .volatile(),
  mdnsName: z.string().default('')
    .description('Service name used in the mDNS advertisement; empty derives one from the hostname.')
    .volatile(),
})

/**
 * Read the live values out of a resolved {@link ConfigSchema}.
 *
 * Every `.volatile()` field resolves to a handle rather than a value, so the
 * plugin's own code — which has no business knowing about handles — reads
 * through them here, once, at the boundary. Calling this on every use is the
 * point: it is what makes a settings edit visible to a running relay instead of
 * frozen at the value the process started with.
 *
 * `stateDir` is the one plain field and is copied straight across.
 *
 * @param config - the resolved schema instance handed to `apply`.
 * @returns a snapshot of the current configuration, in plain values.
 */
export function plainConfig(config: ConfigSchema): Config {
  return {
    bind: config.bind.get(),
    port: config.port.get(),
    stateDir: config.stateDir,
    // A volatile array handle yields a readonly snapshot, and `Config` declares
    // these mutable so the rest of the plugin can keep treating them as data.
    trustedHosts: [...config.trustedHosts.get()],
    publicHostnames: [...config.publicHostnames.get()],
    tls: config.tls.get(),
    tlsCertPath: config.tlsCertPath.get(),
    tlsKeyPath: config.tlsKeyPath.get(),
    auth: config.auth.get(),
    sessionTtlMs: config.sessionTtlMs.get(),
    deviceTokenTtlMs: config.deviceTokenTtlMs.get(),
    pairingWindowMs: config.pairingWindowMs.get(),
    pairingCodeLength: config.pairingCodeLength.get(),
    maxFailedAttempts: config.maxFailedAttempts.get(),
    lockoutMs: config.lockoutMs.get(),
    rateLimitPerMinute: config.rateLimitPerMinute.get(),
    privilegedMethods: config.privilegedMethods.get(),
    extraProxyPaths: [...config.extraProxyPaths.get()],
    proxyTimeoutMs: config.proxyTimeoutMs.get(),
    compat: {
      addressGrants: config.compat.addressGrants.get(),
      addressGrantTtlMs: config.compat.addressGrantTtlMs.get(),
      plainPort: config.compat.plainPort.get(),
    },
    uiLink: config.uiLink.get(),
    mdns: config.mdns.get(),
    mdnsName: config.mdnsName.get(),
  }
}

/**
 * Reject a configuration whose fields contradict each other.
 *
 * Self-contained constraints the schema cannot express fail here, at load,
 * rather than at the first request that trips over them.
 * @param config - the resolved configuration.
 * @throws {Error} naming the field pair that cannot hold together.
 */
export function assertCoherent(config: Config): void {
  if (config.tls === 'files' && (config.tlsCertPath === '' || config.tlsKeyPath === '')) {
    throw new Error('dsh-relay: tls "files" requires both tlsCertPath and tlsKeyPath')
  }
  if (config.compat.plainPort !== 0 && config.compat.plainPort === config.port) {
    throw new Error('dsh-relay: compat.plainPort must differ from port')
  }
  for (const path of config.extraProxyPaths) {
    if (!path.startsWith('/')) {
      throw new Error(`dsh-relay: extraProxyPaths entry ${JSON.stringify(path)} must start with "/"`)
    }
  }
}
