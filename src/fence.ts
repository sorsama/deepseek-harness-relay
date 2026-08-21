/**
 * The relay's browser-trust fence.
 *
 * This is not optional bookkeeping. The relay reaches the harness by rewriting
 * `Host` to the loopback authority, which is precisely what the harness's own
 * fence exists to detect — so from the moment the relay proxies anything, the
 * relay IS the DNS-rebinding fence and the cross-site fence. Removing it would
 * let any web page the operator visits point a short-TTL DNS record at the
 * relay's address and drive the agent from the victim's own network position,
 * carrying the victim's own address grant.
 *
 * The rules mirror the harness's `api-request-trust.ts` and are applied before
 * any authentication check, because an untrusted authority must not reach the
 * credential comparison at all.
 *
 * Authentication is a separate layer and lives in `auth/`. This module answers
 * only "is this request addressed to us, by something allowed to address us".
 * @module dsh-relay/fence
 */

import type { IncomingHttpHeaders } from 'node:http'
import { networkInterfaces } from 'node:os'

/** The request facts the fence reads. */
export interface FenceRequest {
  readonly headers: IncomingHttpHeaders
  /** HTTP method; a cross-site read navigation is judged differently from a write. */
  readonly method?: string | undefined
}

/** Why a request was refused, for the log line and the response body. */
export type FenceRejection =
  | 'missing-host'
  | 'unparsable-host'
  | 'untrusted-host'
  | 'cross-site'
  | 'opaque-origin'
  | 'origin-mismatch'

/**
 * Read one header as a single string.
 * @param headers - the request's header map.
 * @param name - lowercase header name.
 * @returns the value, or undefined when absent or repeated.
 */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a bare `host` or `host:port` authority through WHATWG normalization.
 * @param authority - the raw authority.
 * @returns the normalized URL, or undefined when it does not parse.
 */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG special scheme: parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Canonical form of a parsed authority: `hostname`, or `hostname:port` when a
 * port was written. The port is judged from parses under both special schemes,
 * never from the raw string, so `:80` and `:443` still count as explicit.
 * @param authority - the raw authority, as written.
 * @param parsed - the same authority parsed under `http:`.
 * @returns the canonical authority.
 */
function canonicalAuthority(authority: string, parsed: URL): string {
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${authority}`).port
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`
}

/**
 * Whether a normalized hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname; IPv6 literals retain their brackets.
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether an address is in a private, link-local, or loopback range.
 *
 * Address grants are refused outside these ranges: a public address is shared
 * by everyone behind the same carrier NAT, so granting one would admit
 * strangers along with the operator's phone.
 * @param address - a bare IPv4 or IPv6 address, brackets optional.
 * @returns true when the address is private, link-local, or loopback.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[/, '').replace(/\]$/, '').replace(/^::ffff:/i, '')
  if (bare === '::1') return true
  const lower = bare.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true
  const octets = bare.split('.')
  if (octets.length !== 4) return false
  if (!octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false
  const a = Number(octets[0])
  const b = Number(octets[1])
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Refuse a configured authority that is not already canonical.
 *
 * Anything WHATWG parsing would silently rewrite is a typo that must fail the
 * load rather than quietly widening or narrowing the grant: URL parts beyond
 * the authority, a dangling colon, a zero-padded port, or a non-canonical host
 * spelling.
 * @param entry - the configured value, verbatim.
 * @throws {Error} naming the offending entry.
 */
export function assertTrustedAuthority(entry: string): void {
  const parsed = parseAuthority(entry)
  if (parsed !== undefined && canonicalAuthority(entry, parsed) === entry.toLowerCase()) return
  throw new Error(`dsh-relay: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/**
 * The IPv4 literals this machine is reachable at on its own networks.
 * @returns non-internal IPv4 addresses, in interface order.
 */
export function localAddresses(): string[] {
  const addresses: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * The authorities this relay answers to.
 * @param options.trustedHosts - operator-declared authorities, already validated.
 * @param options.publicHostnames - names a port-forwarded deployment is reached by.
 * @returns port-less authorities plus loopback, deduplicated.
 */
export function relayAuthorities(options: {
  readonly trustedHosts: readonly string[]
  readonly publicHostnames: readonly string[]
}): string[] {
  return [...new Set([
    '127.0.0.1',
    'localhost',
    ...localAddresses(),
    ...options.publicHostnames,
    ...options.trustedHosts,
  ])]
}

/**
 * Whether the request authority matches one declared authority. An entry with
 * an explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port, which is the shape a bind-derived IP literal takes
 * when the listen port is OS-assigned.
 * @param hostUrl - the parsed request authority.
 * @param authorities - the declared authorities.
 * @returns true on a match.
 */
function matchesAuthority(hostUrl: URL, authorities: readonly string[]): boolean {
  return authorities.some((entry) => {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) return false
    return canonicalAuthority(entry, parsed) === parsed.hostname
      ? parsed.hostname === hostUrl.hostname
      : parsed.host === hostUrl.host
  })
}

/**
 * Whether this is a browser navigating to a page, rather than fetching data.
 *
 * `navigate` mode with a `document` destination is the shape of a person
 * arriving; restricting it to GET and HEAD keeps a cross-site form post — the
 * actual request-forgery vector, which shares that mode and destination —
 * on the refused side.
 * @param request - the inbound request's method and headers.
 * @returns true when the request is a safe top-level navigation.
 */
function isReadNavigation(request: FenceRequest): boolean {
  const method = (request.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  if (header(request.headers, 'sec-fetch-mode') !== 'navigate') return false
  const destination = header(request.headers, 'sec-fetch-dest')
  return destination === undefined || destination === 'document'
}

/**
 * Decide whether one request may reach the relay's routes or its proxy.
 * @param request - the inbound request's headers.
 * @param authorities - the authorities this relay answers to.
 * @returns the rejection reason, or undefined when the request passes.
 */
export function checkFence(request: FenceRequest, authorities: readonly string[]): FenceRejection | undefined {
  // Host fence, applied to every request. A rebound page carries the
  // attacker's domain here even though the socket landed on this server, and
  // Host is the one header rebinding cannot forge. There is no marker
  // shortcut: a browser read over plain HTTP arrives with neither Origin nor
  // Fetch-Metadata, indistinguishable from a native client.
  const host = header(request.headers, 'host')
  if (host === undefined) return 'missing-host'
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return 'unparsable-host'
  if (!isLoopbackHostname(hostUrl.hostname) && !matchesAuthority(hostUrl, authorities)) return 'untrusted-host'
  // Cross-site fence. The marker alone is not grounds to refuse: a person
  // typing this relay's address into the bar, or following a link to it from
  // anywhere else, produces a cross-site top-level navigation, and refusing
  // that would make the relay unreachable by the ordinary means of reaching a
  // web page. What must be refused is a cross-site request that READS DATA or
  // WRITES — a fetch, an image, a subresource, or a form post — because those
  // are the shapes a hostile page can use. A cross-site GET navigation only
  // hands the person a page they asked for.
  if (header(request.headers, 'sec-fetch-site') === 'cross-site' && !isReadNavigation(request)) {
    return 'cross-site'
  }
  // Origin fence: when a browser attaches an Origin it must be this authority.
  // Absent Origin is fine — the Host fence already bound the request, and the
  // native client sends none. The literal "null" is an opaque origin.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return undefined
  if (origin === 'null') return 'opaque-origin'
  try {
    return new URL(origin).host === hostUrl.host ? undefined : 'origin-mismatch'
  } catch {
    return 'origin-mismatch'
  }
}
