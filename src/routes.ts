/**
 * The relay's own endpoints, everything under `/relay`.
 *
 * These are the pages and the small JSON API that gate the proxy: sign-in,
 * device enrolment, the device list, and revocation. Nothing here is
 * forwarded upstream.
 *
 * Two rules shape the whole module. Invitations are issued only to an
 * operator — a request arriving on loopback, or one already carrying a
 * password session — never to the device asking to be paired, because an
 * endpoint that mints its own invitations on demand is a confused deputy. And
 * every unauthorized answer is HTTP 403, never 401: DSH Mobile reads 403 as
 * "the harness is there and refused this address", which is a usable pairing
 * hint, and anything else as "not a harness at all".
 * @module dsh-relay/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import QRCode from 'qrcode'
import type { Authenticator, Identity } from './auth/index.ts'
import { SESSION_COOKIE } from './auth/index.ts'
import { pairingPayload } from './auth/pairing.ts'
import type { Config } from './config.ts'
import { claimPage, devicesPage, loginPage, messagePage, pairPage, pairedPage, passwordPage } from './pages/views.ts'
import { parseFields, readBody, safeNextPath, sendHtml, sendJson, sendRedirect, sessionCookie, wantsJson } from './wire.ts'

/** Prefix owning every route in this module. */
export const RELAY_PREFIX = '/relay'

/** What a route handler is given. */
export interface RouteContext {
  readonly auth: Authenticator
  readonly config: Config
  readonly identity: Identity
  readonly address: string
  /** Origin the client reached this relay on, for links and the QR payload. */
  readonly origin: string
  /** Plain-HTTP origin, when the compatibility listener is running. */
  readonly plainOrigin?: string | undefined
  /** SPKI pin of the served certificate; absent on a plaintext listener. */
  readonly fingerprint?: string | undefined
  /** Whether this request arrived over TLS, deciding the cookie's Secure flag. */
  readonly secure: boolean
  readonly now: number
}

/** Whether this identity may issue invitations and manage devices. */
function isOperator(identity: Identity): boolean {
  return identity.credential === 'loopback' || identity.credential === 'session'
}

/** Whether this identity may see the harness at all. */
export function isAuthenticated(identity: Identity): boolean {
  return identity.credential !== 'none'
}

/**
 * Refuse a request, in whichever representation the caller asked for.
 * @param req - the inbound request, read for its Accept header.
 * @param res - the response to write.
 * @param message - the reason, safe to show a client.
 */
function refuse(req: IncomingMessage, res: ServerResponse, message: string): void {
  if (wantsJson(req)) {
    sendJson(res, 403, { error: 'forbidden', message })
    return
  }
  sendHtml(res, 403, messagePage({ title: 'Not allowed', message, kind: 'error' }))
}

/**
 * Render the QR carrying an invitation.
 * @param context - the relay's origins and certificate identity.
 * @param code - the live invitation.
 * @returns the QR as inline SVG.
 */
async function renderQr(context: RouteContext, code: { code: string, expiresAt: number }): Promise<string> {
  const payload = pairingPayload({
    url: context.origin,
    plainUrl: context.plainOrigin,
    fingerprint: context.fingerprint,
    code,
  })
  return QRCode.toString(JSON.stringify(payload), {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#0f1115', light: '#ffffff' },
  })
}

/**
 * Handle one `/relay` request.
 * @param req - the inbound request.
 * @param res - the response, owned entirely by this call.
 * @param url - the parsed request URL.
 * @param context - the relay's live state for this request.
 * @returns resolution once the response is finished.
 */
export async function handleRelayRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: RouteContext,
): Promise<void> {
  const { auth, config, identity, now } = context
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Liveness only. It names the product and nothing about the harness behind
  // it, so an unauthenticated scan learns no more than that a port is open.
  if (path === '/relay/health' && (method === 'GET' || method === 'HEAD')) {
    sendJson(res, 200, { service: 'dsh-relay', ok: true })
    return
  }

  if (path === '/relay/login' && method === 'GET') {
    // Setup comes before the redirect. A loopback request is the operator and
    // is let through to the harness without signing in — which, before this
    // branch existed, meant the one place a password could be set bounced
    // straight past the form and no password could ever be set at all.
    if (!auth.hasPassword && isOperator(identity)) {
      sendRedirect(res, '/relay/password')
      return
    }
    if (isAuthenticated(identity)) {
      sendRedirect(res, safeNextPath(url.searchParams.get('next')))
      return
    }
    if (!auth.hasPassword) {
      refuse(req, res, 'No password is set yet. Set one from the machine running the harness first.')
      return
    }
    sendHtml(res, 200, loginPage({ next: safeNextPath(url.searchParams.get('next')) }))
    return
  }

  if (path === '/relay/password' && method === 'GET') {
    if (auth.hasPassword ? !isOperator(identity) : identity.credential !== 'loopback') {
      refuse(req, res, 'Set the password from the machine running the harness.')
      return
    }
    sendHtml(res, 200, passwordPage({
      hasPassword: auth.hasPassword,
      next: safeNextPath(url.searchParams.get('next')),
    }))
    return
  }

  if (path === '/relay/password' && method === 'POST') {
    // Setting the first password is a loopback-only act: until one exists
    // there is nothing to authenticate against, so accepting it from the
    // network would let whoever reaches the port first claim the relay.
    if (auth.hasPassword ? !isOperator(identity) : identity.credential !== 'loopback') {
      refuse(req, res, 'Set the password from the machine running the harness.')
      return
    }
    const body = await readBody(req)
    if (body === undefined) { refuse(req, res, 'Request too large.'); return }
    const fields = parseFields(req, body)
    const password = fields.password ?? ''
    const next = safeNextPath(fields.next ?? '/relay/devices')
    const reject = (message: string): void => {
      sendHtml(res, 400, passwordPage({ hasPassword: auth.hasPassword, error: message, next }))
    }
    if (password.length < 10) { reject('Use at least 10 characters.'); return }
    if (fields.confirm !== undefined && fields.confirm !== password) {
      reject('The two passwords do not match.')
      return
    }
    await auth.setPassword(password)
    if (wantsJson(req)) { sendJson(res, 200, { ok: true }); return }
    sendRedirect(res, next)
    return
  }

  if (path === '/relay/login' && method === 'POST') {
    const body = await readBody(req)
    if (body === undefined) { refuse(req, res, 'Request too large.'); return }
    const fields = parseFields(req, body)
    const next = safeNextPath(fields.next ?? '/')
    const outcome = await auth.signIn(fields.password ?? '', context.address, now)
    if (outcome === 'no-password') {
      refuse(req, res, 'No password is set yet.')
      return
    }
    if (outcome === 'locked-out') {
      // `Retry-After` because the client contract says a 429 carries one, and a client that
      // believed it would otherwise busy-retry against a lockout: the rate limiter sets the header
      // but this path never did, and the two are indistinguishable from the outside.
      sendHtml(res, 429, loginPage({ error: 'Too many attempts. Try again later.', next }), {
        'retry-after': String(Math.ceil(config.lockoutMs / 1000)),
      })
      return
    }
    if (outcome === 'bad-password') {
      sendHtml(res, 403, loginPage({ error: 'That password did not match.', next }))
      return
    }
    const cookie = sessionCookie({
      name: SESSION_COOKIE,
      value: outcome.cookie,
      maxAgeSeconds: Math.floor(config.sessionTtlMs / 1000),
      secure: context.secure,
    })
    if (wantsJson(req)) {
      sendJson(res, 200, { expiresAt: outcome.expiresAt }, { 'set-cookie': cookie })
      return
    }
    sendRedirect(res, next, { 'set-cookie': cookie })
    return
  }

  if (path === '/relay/logout' && method === 'POST') {
    const cookie = sessionCookie({ name: SESSION_COOKIE, value: '', maxAgeSeconds: 0, secure: context.secure })
    sendRedirect(res, '/relay/login', { 'set-cookie': cookie })
    return
  }

  if (path === '/relay/pair/new' && method === 'POST') {
    if (!isOperator(identity)) {
      refuse(req, res, 'Pairing codes are issued from the machine running the harness.')
      return
    }
    auth.pairing.issue(config.pairingCodeLength, config.pairingWindowMs, now)
    sendRedirect(res, '/relay/pair')
    return
  }

  if (path === '/relay/pair' && method === 'GET') {
    // An operator sees the invitation to hand out; a device sees the form to
    // claim one. The same path serves both so a QR and a typed URL agree.
    if (isOperator(identity)) {
      const code = auth.pairing.peek(now) ?? auth.pairing.issue(config.pairingCodeLength, config.pairingWindowMs, now)
      sendHtml(res, 200, pairPage({
        qrSvg: await renderQr(context, code),
        code: code.code,
        expiresInSeconds: Math.max(0, Math.round((code.expiresAt - now) / 1000)),
        url: context.origin,
        plainUrl: context.plainOrigin,
        fingerprint: context.fingerprint,
      }))
      return
    }
    const supplied = url.searchParams.get('code')
    sendHtml(res, 200, claimPage({ code: supplied ?? undefined }))
    return
  }

  if (path === '/relay/pair' && method === 'POST') {
    const body = await readBody(req)
    if (body === undefined) { refuse(req, res, 'Request too large.'); return }
    const fields = parseFields(req, body)
    const paired = await auth.pair({
      code: fields.code ?? '',
      name: fields.name ?? fields.deviceName ?? 'device',
      address: context.address,
    }, now)
    if (paired === 'locked-out') {
      // 429 rather than the pairing-failed 403: nothing is wrong with the code, and a client told
      // otherwise reloads the pairing page and spends another attempt learning the same thing.
      const until = auth.lockedUntil(context.address, now) ?? now + config.lockoutMs
      const retryAfter = String(Math.max(1, Math.ceil((until - now) / 1000)))
      if (wantsJson(req)) {
        sendJson(res, 429, { error: 'rate-limited', message: 'Too many attempts. Try again later.' }, {
          'retry-after': retryAfter,
        })
        return
      }
      sendHtml(res, 429, claimPage({ error: 'Too many attempts from this device. Try again later.' }), {
        'retry-after': retryAfter,
      })
      return
    }
    if (paired === undefined) {
      if (wantsJson(req)) {
        sendJson(res, 403, { error: 'pairing-failed', message: 'That code is not valid.' })
        return
      }
      sendHtml(res, 403, claimPage({ error: 'That code is not valid, has expired, or was already used.' }))
      return
    }
    const granted = context.config.compat.addressGrants
      && auth.identify({ headers: {}, address: context.address, local: false }, now).credential === 'address-grant'
    if (wantsJson(req)) {
      sendJson(res, 200, {
        deviceId: paired.device.id,
        token: paired.token,
        expiresAt: paired.device.expiresAt,
        ...context.fingerprint !== undefined && { fingerprint: context.fingerprint },
      })
      return
    }
    const cookie = sessionCookie({
      name: SESSION_COOKIE,
      value: '',
      maxAgeSeconds: 0,
      secure: context.secure,
    })
    sendHtml(res, 200, pairedPage({
      deviceName: paired.device.name,
      token: paired.token,
      granted,
      plainUrl: context.plainOrigin,
    }), { 'set-cookie': cookie })
    return
  }

  if (path === '/relay/devices' && method === 'GET') {
    if (!isOperator(identity)) { refuse(req, res, 'Sign in to manage devices.'); return }
    sendHtml(res, 200, devicesPage({
      devices: auth.devices,
      now,
      tlsMode: config.tls,
      hasPassword: auth.hasPassword,
      fingerprint: context.fingerprint,
      url: context.origin,
      plainUrl: context.plainOrigin,
    }))
    return
  }

  if (path === '/relay/devices/revoke' && method === 'POST') {
    if (!isOperator(identity)) { refuse(req, res, 'Sign in to manage devices.'); return }
    const body = await readBody(req)
    if (body === undefined) { refuse(req, res, 'Request too large.'); return }
    const fields = parseFields(req, body)
    await auth.revoke(fields.deviceId ?? '', now)
    sendRedirect(res, '/relay/devices')
    return
  }

  if (path === '/relay/signout-everywhere' && method === 'POST') {
    if (!isOperator(identity)) { refuse(req, res, 'Sign in to manage devices.'); return }
    await auth.signOutEverywhere()
    const cookie = sessionCookie({ name: SESSION_COOKIE, value: '', maxAgeSeconds: 0, secure: context.secure })
    sendRedirect(res, '/relay/login', { 'set-cookie': cookie })
    return
  }

  if (wantsJson(req)) {
    sendJson(res, 404, { error: 'not-found' })
    return
  }
  sendHtml(res, 404, messagePage({ title: 'Not found', message: 'No such relay endpoint.', kind: 'error' }))
}
