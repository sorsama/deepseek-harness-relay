/**
 * Which origin a pairing QR should carry.
 *
 * A QR is scanned by a phone, so it must name an address the phone can route
 * to. The pairing page is normally opened on the machine running the harness,
 * and that page's own origin is `https://127.0.0.1:3443` — loopback, which is
 * the one address no other device on the network can reach. Encoding that
 * origin produced a QR that scanned successfully and then failed to connect:
 * the bug this module exists to remove.
 *
 * The machine usually has several non-loopback addresses, and only one of them
 * is the network the phone is on. Nothing here can know which — a virtual
 * machine adapter, a VPN, and the real Ethernet port all look like addresses —
 * so this module offers an ordering as a best guess and keeps the whole list so
 * the operator can pick. It deliberately mirrors what the relay logs at
 * startup, so the address in the QR is one the operator can see named.
 * @module dsh-relay/origins
 */

import { networkInterfaces } from 'node:os'
import { isLoopbackHostname } from './fence.ts'

/** One address as `node:os` reports it. */
export interface NetworkEntry {
  readonly address: string
  readonly family: string
  readonly internal?: boolean
}

/** The interface map, as `node:os.networkInterfaces()` returns it. */
export type NetworkMap = Readonly<Record<string, readonly NetworkEntry[] | undefined>>

/** Interface names that are virtual or transport-only: usable, but rarely the phone's network. */
const VIRTUAL = /(vEthernet|Hyper-V|WSL|Virtual|VMware|VirtualBox|Docker|Bluetooth|Loopback|Tailscale|ZeroTier|Radmin|TAP|TUN|VPN)/i

/** Interface names that are usually the real network the phone is on. */
const PHYSICAL = /(Wi-?Fi|WLAN|Wireless|Ethernet|LAN)/i

/**
 * The origins a phone could plausibly reach this relay at, best guess first.
 * @param interfaces - the interface map; injectable so the ordering is testable.
 * @param scheme - the primary listener's scheme.
 * @param port - the primary listener's port.
 * @returns deduplicated `scheme://host:port` origins, most likely first.
 */
export function pairingOrigins(
  interfaces: NetworkMap,
  scheme: 'http' | 'https',
  port: number,
): string[] {
  const scored: { readonly origin: string, readonly score: number }[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal === true) continue
      if (!routable(entry.address)) continue
      // Lower wins. Link-local IPv4 (169.254/16) only works on the same link,
      // usually not where the phone is; virtual adapters are reachable in
      // principle but are the wrong guess in practice.
      const rank = entry.address.startsWith('169.254.') ? 3 : VIRTUAL.test(name) ? 2 : PHYSICAL.test(name) ? 0 : 1
      const family = entry.family === 'IPv4' || entry.family === '4' ? 0 : 1
      scored.push({ origin: `${scheme}://${formatHost(entry.address)}:${String(port)}`, score: rank * 10 + family })
    }
  }
  scored.sort((left, right) => left.score - right.score)
  return [...new Set(scored.map(entry => entry.origin))]
}

/**
 * The origins to offer on the pairing page, with the origin the operator is
 * already using kept in front.
 *
 * A loopback origin is never offered as a candidate: the phone cannot reach it,
 * so the page would present a QR that cannot work. When no network address
 * exists at all the loopback origin stays, because a QR that names the wrong
 * address is recoverable on the page while an empty page is not.
 * @param origin - the origin this page was requested on.
 * @param candidates - the machine's network origins, from {@link pairingOrigins}.
 * @returns one or more origins, the default first.
 */
export function pairingOriginOptions(origin: string, candidates: readonly string[]): string[] {
  if (isLoopbackOrigin(origin)) return candidates.length > 0 ? [...new Set(candidates)] : [origin]
  return [...new Set([origin, ...candidates.filter(candidate => candidate !== origin)])]
}

/**
 * Whether an origin names loopback.
 * @param origin - a `scheme://host[:port]` string.
 * @returns true for 127.0.0.0/8, ::1, and `localhost`.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Whether an address is worth putting in a QR at all.
 * @param address - one interface address.
 * @returns false for loopback and IPv6 link-local, which need a scope id.
 */
function routable(address: string): boolean {
  if (address === '') return false
  if (address.startsWith('127.') || address === '::1') return false
  if (/^fe80:/i.test(address)) return false
  return true
}

/**
 * Format an address as a URL authority.
 * @param address - an IPv4 or IPv6 literal.
 * @returns the literal, bracketed when it is IPv6.
 */
function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

/** The operating system's interface map; a named export so tests need no stub of `node:os`. */
export const systemInterfaces = networkInterfaces
