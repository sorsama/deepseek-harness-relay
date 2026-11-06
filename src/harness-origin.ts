/**
 * How a request addressed to the harness's own web server is treated.
 *
 * Earlier releases redirected every `/relay/...` request there to the relay's
 * TLS listener. That is fatal to the desktop app: its window is an Electron
 * page, a main-frame navigation onto a self-signed certificate cannot complete,
 * and Electron reports the failure as a crash the app restarts onto.
 *
 * The route is now served instead — the same relay pages, rendered on the
 * harness origin — so the desktop window can change page in place, and a
 * browser on the machine can open `/relay/devices` directly.
 *
 * One caller still needs the redirect: DSH Mobile resolves *where* a relay is
 * by asking `/relay/health` and reading a 3xx that names the same path. So the
 * redirect survives for that probe and nothing else. A document navigation
 * (`Accept: text/html`) never receives it — that is the request the desktop app
 * makes, and the one that must never see a certificate it cannot trust.
 * @module dsh-relay/harness-origin
 */

import type { IncomingMessage } from 'node:http'
import { isLoopbackHostname } from './fence.ts'

/** What to do with one request that reached the harness origin under `/relay`. */
export type HarnessOriginAction = 'serve' | 'redirect' | 'refuse'

/** The one path the mobile client probes to find a relay. */
const DISCOVERY_PATH = '/relay/health'

/**
 * Decide one request's fate on the harness origin.
 * @param request - the inbound request.
 * @param loopbackPeer - whether the socket peer is this machine. The harness
 * binds loopback, so a non-loopback peer means something unexpected is in
 * front of it and the route stays closed.
 * @returns serve the relay route, answer the discovery probe with a redirect,
 * or refuse.
 */
export function harnessOriginAction(request: IncomingMessage, loopbackPeer: boolean): HarnessOriginAction {
  if (!loopbackPeer || !harnessOriginTrusted(request)) return 'refuse'
  const method = request.method ?? 'GET'
  const isRead = method === 'GET' || method === 'HEAD'
  if (!isRead) return 'serve'
  const accept = request.headers.accept ?? ''
  // A document navigation must be answered with a page: this is the desktop
  // app changing page, and a redirect here would hand its window an origin it
  // cannot trust.
  if (accept.includes('text/html')) return 'serve'
  const path = (request.url ?? '/').split('?', 1)[0]
  return path === DISCOVERY_PATH ? 'redirect' : 'serve'
}

/**
 * Whether a request addressed to the harness origin is addressed to this
 * server by something allowed to address it.
 *
 * The harness's own fence checks `/api` and knows nothing about `/relay`, so
 * serving these privileged pages there needs the same guards the relay's own
 * listener applies: the authority must be loopback (a page that rebinds a
 * name to this machine sends its own name as `Host`), and a browser-declared
 * cross-site request is refused outright. The `Origin` header is absent on a
 * plain navigation, which is the ordinary way these pages are opened.
 * @param request - the inbound request.
 * @returns true when the request may reach the relay's routes.
 */
export function harnessOriginTrusted(request: IncomingMessage): boolean {
  const authority = typeof request.headers.host === 'string' ? request.headers.host : ''
  if (!isLoopbackAuthority(authority)) return false
  const origin = request.headers.origin
  if (typeof origin === 'string' && !allowedOrigin(origin)) return false
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  return true
}

/**
 * Whether a `Host` authority names loopback.
 * @param authority - the header value, with or without a port.
 * @returns true for loopback names and literals.
 */
function isLoopbackAuthority(authority: string): boolean {
  const hostname = authority.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
  return isLoopbackHostname(hostname)
}

/**
 * Whether an `Origin` header may drive these routes.
 *
 * The desktop app's window is a `dsh-app:` page whose navigations are proxied
 * to the harness; a loopback `http:` page is a browser on this machine. A
 * public page that POSTs here cross-site carries its own origin and is refused.
 * @param origin - the header value.
 * @returns true when the origin is this machine or the desktop shell.
 */
function allowedOrigin(origin: string): boolean {
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'dsh-app:') return true
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}
