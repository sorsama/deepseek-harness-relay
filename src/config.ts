/**
 * The relay's configuration surface.
 *
 * Every value two deployments could reasonably want set differently is a field
 * here, per the harness's "no hardcoded tunables" rule: the test is whether
 * `cordis.yml` can change it without a code edit. Protocol constants and
 * security invariants stay fixed in code.
 * @module dsh-relay/config
 */

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
   * disables the listener; it only ever accepts address-granted clients.
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

export const Config: z<Config> = z.object({
  bind: z.string().default('0.0.0.0'),
  port: z.natural().max(65535).default(3443),
  stateDir: z.string().required(),
  trustedHosts: z.array(String).default([]),
  publicHostnames: z.array(String).default([]),
  tls: z.union(['self-signed', 'files', 'off'] as const).default('self-signed'),
  tlsCertPath: z.string().default(''),
  tlsKeyPath: z.string().default(''),
  auth: z.union(['password', 'device-token', 'both'] as const).default('both'),
  sessionTtlMs: z.natural().min(60_000).default(43_200_000),
  deviceTokenTtlMs: z.natural().min(60_000).default(2_592_000_000),
  pairingWindowMs: z.natural().min(10_000).default(300_000),
  pairingCodeLength: z.natural().min(6).max(12).default(8),
  maxFailedAttempts: z.natural().min(1).default(5),
  lockoutMs: z.natural().min(1_000).default(900_000),
  rateLimitPerMinute: z.natural().min(1).default(600),
  privilegedMethods: z.union(['allow-authenticated', 'loopback-only'] as const).default('allow-authenticated'),
  extraProxyPaths: z.array(String).default([]),
  proxyTimeoutMs: z.natural().min(1_000).default(120_000),
  compat: z.object({
    addressGrants: z.boolean().default(true),
    addressGrantTtlMs: z.natural().min(60_000).default(86_400_000),
    plainPort: z.natural().max(65535).default(0),
  }),
  uiLink: z.boolean().default(true),
  mdns: z.boolean().default(true),
  mdnsName: z.string().default(''),
})

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
  if (config.compat.plainPort !== 0 && !config.compat.addressGrants) {
    throw new Error(
      'dsh-relay: compat.plainPort serves only address-granted clients, so it is unreachable '
      + 'while compat.addressGrants is false',
    )
  }
  for (const path of config.extraProxyPaths) {
    if (!path.startsWith('/')) {
      throw new Error(`dsh-relay: extraProxyPaths entry ${JSON.stringify(path)} must start with "/"`)
    }
  }
}
