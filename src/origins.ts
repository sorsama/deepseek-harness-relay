/**
 * Which origin a pairing QR should carry, and how the pairing page should
 * label it.
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
 *
 * Each address also carries the label the picker shows. A raw
 * `https://[2405:9800:…]:3443` is nearly unreadable on a phone, so the label
 * names the adapter and keeps only the numeric address: `Wi-Fi — 192.168.1.5`.
 * A Tailscale-like adapter earns the `Tailscale` name only when the address is
 * verified to belong to Tailscale (see {@link isTailscaleAddress}); an adapter
 * that merely has "Tailscale" in its name is not proof, because a VPN client
 * or a renamed NIC can claim that string.
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

/** One address a device could reach this relay at, with the label a person reads. */
export interface PairingAddress {
  /** `scheme://host:port`, ready for a QR payload or a form value. */
  readonly origin: string
  /** The numeric address alone, unbracketed. */
  readonly address: string
  /** The adapter name `node:os` reported, kept for diagnostics. */
  readonly interfaceName: string
  readonly family: 'IPv4' | 'IPv6'
  /** Whether the address is verified to belong to Tailscale. */
  readonly tailscale: boolean
  /** What the picker shows: `Tailscale — 100.121.55.94`. */
  readonly label: string
}

/** Interface names that are virtual or transport-only: usable, but rarely the phone's network. */
const VIRTUAL = /(vEthernet|Hyper-V|WSL|Virtual|VMware|VirtualBox|Docker|Bluetooth|Loopback|Tailscale|ZeroTier|Radmin|TAP|TUN|VPN)/i

/** Interface names that are usually the real network the phone is on. */
const PHYSICAL = /(Wi-?Fi|WLAN|Wireless|Ethernet|LAN)/i

/**
 * Adapter names a person recognises. Ordered: the first match wins, because
 * "vEthernet (WSL)" is a WSL switch before it is a Hyper-V one.
 */
const FRIENDLY_NAMES: readonly (readonly [RegExp, string])[] = [
  [/WSL/i, 'WSL'],
  [/Docker/i, 'Docker'],
  [/Hyper-?V|vEthernet/i, 'Hyper-V'],
  [/VirtualBox/i, 'VirtualBox'],
  [/VMware/i, 'VMware'],
  [/ZeroTier/i, 'ZeroTier'],
  [/Radmin/i, 'Radmin'],
  [/Bluetooth/i, 'Bluetooth'],
  [/Wi-?Fi|WLAN|Wireless/i, 'Wi-Fi'],
  [/Ethernet/i, 'Ethernet'],
  [/TAP|TUN|VPN/i, 'VPN'],
]

/** First two octets of Tailscale's IPv4 CGNAT range, 100.64.0.0/10. */
const TAILSCALE_V4_FIRST = 100
const TAILSCALE_V4_SECOND_MIN = 64
const TAILSCALE_V4_SECOND_MAX = 127

/** Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48. Assigned by Tailscale alone. */
const TAILSCALE_V6 = /^fd7a:115c:a1e0:/i

/**
 * The origins a phone could plausibly reach this relay at, best guess first.
 * @param interfaces - the interface map; injectable so the ordering is testable.
 * @param scheme - the primary listener's scheme.
 * @param port - the primary listener's port.
 * @returns deduplicated candidates, most likely first, each labelled.
 */
export function pairingOrigins(
  interfaces: NetworkMap,
  scheme: 'http' | 'https',
  port: number,
): PairingAddress[] {
  const scored: { readonly candidate: PairingAddress, readonly score: number }[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    const list = entries ?? []
    // Tailscale assigns its IPv6 ULA to the same adapter as its IPv4 address,
    // so a verified ULA on this adapter verifies the adapter's 100.64/10
    // address too — including on macOS, whose `utun` names never say Tailscale.
    const adapterVerified = list.some(entry => TAILSCALE_V6.test(entry.address))
    for (const entry of list) {
      if (entry.internal === true) continue
      if (!routable(entry.address)) continue
      // Lower wins. Link-local IPv4 (169.254/16) only works on the same link,
      // usually not where the phone is; virtual adapters are reachable in
      // principle but are the wrong guess in practice.
      const rank = entry.address.startsWith('169.254.') ? 3 : VIRTUAL.test(name) ? 2 : PHYSICAL.test(name) ? 0 : 1
      const family = entry.family === 'IPv4' || entry.family === '4' ? 'IPv4' : 'IPv6'
      const tailscale = isTailscaleAddress(name, entry.address, adapterVerified)
      scored.push({
        candidate: {
          origin: `${scheme}://${formatHost(entry.address)}:${String(port)}`,
          address: entry.address,
          interfaceName: name,
          family,
          tailscale,
          label: labelFor(name, entry.address, tailscale),
        },
        score: rank * 10 + (family === 'IPv4' ? 0 : 1),
      })
    }
  }
  scored.sort((left, right) => left.score - right.score)
  return dedupe(scored.map(entry => entry.candidate))
}

/**
 * Whether an address is verified Tailscale.
 *
 * The interface name alone is not enough: a VPN client can create an adapter
 * called "Tailscale", and the 100.64.0.0/10 range is CGNAT that a carrier
 * network also hands out. Verification therefore needs an address only
 * Tailscale assigns — its `fd7a:115c:a1e0::/48` ULA, either on this address or
 * on the same adapter — or a 100.64/10 address on an adapter whose name says
 * Tailscale. A 100.64/10 address on any other adapter stays unverified.
 * @param name - the adapter name from `node:os`.
 * @param address - one address on that adapter.
 * @param adapterVerified - whether another address on the same adapter is
 * Tailscale's ULA (callers that inspect a whole adapter pass this).
 * @returns true only when the address is proven to be Tailscale's.
 */
export function isTailscaleAddress(
  name: string,
  address: string,
  adapterVerified = false,
): boolean {
  if (TAILSCALE_V6.test(address)) return true
  if (!isTailscaleV4(address)) return false
  return adapterVerified || /tailscale/i.test(name)
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
 * @returns one or more candidates, the default first.
 */
export function pairingOriginOptions(
  origin: string,
  candidates: readonly PairingAddress[],
): PairingAddress[] {
  if (isLoopbackOrigin(origin)) return candidates.length > 0 ? dedupe(candidates) : [syntheticAddress(origin)]
  const current = candidates.find(candidate => candidate.origin === origin) ?? syntheticAddress(origin)
  return dedupe([current, ...candidates])
}

/**
 * Whether an origin names loopback.
 * @param origin - a `scheme://host[:port]` string.
 * @returns true for 127.0.0.0/8, ::1, and `localhost`.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHostname(new URL(origin).hostname.replace(/^\[|\]$/g, ''))
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

/**
 * The label the picker shows: the adapter a person recognises and the numeric
 * address, with the scheme and port dropped because every option shares them.
 * @param name - the adapter name.
 * @param address - the numeric address.
 * @param tailscale - whether the address is verified Tailscale.
 * @returns e.g. `Tailscale — 100.121.55.94`.
 */
function labelFor(name: string, address: string, tailscale: boolean): string {
  if (tailscale) return `Tailscale — ${address}`
  if (address.startsWith('169.254.')) {
    // Link-local cannot be reached from another link, so it is named for what
    // it is even when it sits on a Tailscale adapter (which keeps this address
    // while Tailscale is stopped or signed out).
    return /tailscale/i.test(name) ? `Link-local (Tailscale) — ${address}` : `Link-local — ${address}`
  }
  // The name says Tailscale but the address disproves it. Say so rather than
  // repeating the claim the verification just rejected.
  if (/tailscale/i.test(name)) return `Tailscale (unverified) — ${address}`
  return `${friendlyName(name)} — ${address}`
}

/**
 * A short name for an adapter, falling back to the OS name with any trailing
 * parenthetical (Windows appends the driver/bus description there) removed.
 * @param name - the adapter name from `node:os`.
 * @returns a name suitable for a picker label.
 */
function friendlyName(name: string): string {
  for (const [pattern, label] of FRIENDLY_NAMES) {
    if (pattern.test(name)) return label
  }
  const trimmed = name.replace(/\s*\(.*\)\s*$/, '').trim()
  return trimmed === '' ? 'Network' : trimmed
}

/**
 * A candidate for the origin the operator is already on but which is not in
 * the interface list — behind NAT, or an address that changed since startup.
 * @param origin - a `scheme://host[:port]` string.
 * @returns the labelled candidate.
 */
function syntheticAddress(origin: string): PairingAddress {
  try {
    const url = new URL(origin)
    const address = url.hostname.replace(/^\[|\]$/g, '')
    return {
      origin,
      address,
      interfaceName: '',
      family: address.includes(':') ? 'IPv6' : 'IPv4',
      tailscale: false,
      label: `This address — ${address}`,
    }
  } catch {
    return { origin, address: origin, interfaceName: '', family: 'IPv4', tailscale: false, label: origin }
  }
}

/**
 * Remove duplicate origins, keeping the first (best-ranked) occurrence.
 * @param entries - candidates in preference order.
 * @returns candidates with one entry per origin.
 */
function dedupe(entries: readonly PairingAddress[]): PairingAddress[] {
  const seen = new Set<string>()
  const unique: PairingAddress[] = []
  for (const entry of entries) {
    if (seen.has(entry.origin)) continue
    seen.add(entry.origin)
    unique.push(entry)
  }
  return unique
}

/**
 * Whether a numeric address is inside Tailscale's IPv4 CGNAT range,
 * 100.64.0.0/10.
 * @param address - an address as `node:os` reports it.
 * @returns true for 100.64.0.0 through 100.127.255.255.
 */
function isTailscaleV4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  if (parts[0] !== String(TAILSCALE_V4_FIRST)) return false
  const second = Number(parts[1])
  if (!Number.isInteger(second)) return false
  return second >= TAILSCALE_V4_SECOND_MIN && second <= TAILSCALE_V4_SECOND_MAX
}

/** The operating system's interface map; a named export so tests need no stub of `node:os`. */
export const systemInterfaces = networkInterfaces
