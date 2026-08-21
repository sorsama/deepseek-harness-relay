/**
 * Header translation between the relay's edge and the loopback harness.
 *
 * Two jobs. The first is ordinary proxy hygiene: hop-by-hop headers belong to
 * one connection and must not be forwarded onto another.
 *
 * The second is the deliberate one. The harness answers `/api` only to a
 * loopback authority, and pins its configuration plane to the same test, so
 * the relay presents itself as loopback. That rewrite is only safe because the
 * relay has already applied its own fence to the original headers — see
 * `fence.ts`. Rewriting before that check would hand every rebound page a
 * loopback identity.
 * @module dsh-relay/proxy/rewrite
 */

import type { IncomingHttpHeaders } from 'node:http'

/**
 * Headers scoped to a single hop, per RFC 9110. Forwarding any of them
 * confuses the upstream connection's own framing and keep-alive state.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Headers carrying the relay's own credentials. They authenticate the client
 * to the relay and mean nothing upstream, so they stop here rather than
 * travelling on to a process that does not expect them.
 */
const RELAY_ONLY = new Set(['authorization', 'cookie'])

/**
 * Build the header map for one upstream request.
 * @param headers - the inbound headers, already past the fence.
 * @param loopbackAuthority - `127.0.0.1:<port>` of the harness web server.
 * @param options.keepUpgrade - retain `connection` and `upgrade` for a WebSocket handshake.
 * @returns the headers to send upstream.
 */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  loopbackAuthority: string,
  options: { readonly keepUpgrade?: boolean } = {},
): Record<string, string | string[]> {
  const dropped = new Set(HOP_BY_HOP)
  if (options.keepUpgrade === true) {
    // The handshake IS the upgrade, so those two headers are the payload here.
    dropped.delete('connection')
    dropped.delete('upgrade')
  }
  // A Connection header may name further headers as hop-by-hop; honour it.
  const connection = headers.connection
  if (typeof connection === 'string' && options.keepUpgrade !== true) {
    for (const name of connection.split(',')) dropped.add(name.trim().toLowerCase())
  }

  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (dropped.has(lower) || RELAY_ONLY.has(lower)) continue
    if (lower === 'host' || lower === 'origin' || lower === 'referer') continue
    out[lower] = value
  }

  out.host = loopbackAuthority
  // The harness compares Origin against Host when a browser attaches one, so a
  // forwarded edge Origin would fail that comparison after the Host rewrite.
  // It is rewritten rather than dropped so the upstream still sees a
  // same-origin request rather than an unmarked one.
  if (headers.origin !== undefined) out.origin = `http://${loopbackAuthority}`
  if (headers.referer !== undefined) out.referer = `http://${loopbackAuthority}/`
  return out
}

/**
 * Build the header map for one downstream response.
 * @param headers - the upstream response headers.
 * @returns the headers to send to the client, hop-by-hop entries removed.
 */
export function downstreamHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * Normalize a socket peer address for use as a grant key and log field.
 *
 * Node reports an IPv4 peer on a dual-stack listener as `::ffff:a.b.c.d`;
 * treating that as a different address from `a.b.c.d` would make a grant
 * issued over one listener invisible to the other.
 * @param address - the raw `socket.remoteAddress`, possibly undefined.
 * @returns the normalized address, or an empty string when unknown.
 */
export function normalizeAddress(address: string | undefined): string {
  if (address === undefined) return ''
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  return (mapped?.[1] ?? address).toLowerCase()
}
