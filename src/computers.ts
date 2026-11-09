/**
 * Linking two relays as computers.
 *
 * The direction that starts a link is the one whose operator holds the other
 * machine's pairing code. That caller:
 *
 * 1. offers its own reachable origin and certificate pin, plus a token the
 *    other side may call it with;
 * 2. receives the other side's origin, pin, and the token this side must
 *    present there;
 * 3. records the link.
 *
 * The side that accepted the code records it too, so both Computers pages
 * show the pair without a second manual step. Every later call — status,
 * open — presents one of those two tokens and is checked against the pinned
 * certificate.
 *
 * Nothing here trusts a password: the handoff sets the same session a sign-in
 * would, and only after the peer proved its link token. The browser still sees
 * the peer's self-signed certificate warning once, which the docs say plainly.
 * @module dsh-relay/computers
 */

import type { Authenticator } from './auth/index.ts'
import { mintToken } from './auth/tokens.ts'
import type { Config } from './config.ts'
import { isLoopbackOrigin } from './origins.ts'
import {
  isFingerprint,
  normalizePeerOrigin,
  OpenNonceStore,
  peerName,
  peerRequest,
  type PeerResponse,
} from './peers.ts'
import type { PeerRecord } from './state.ts'

/** Nonces for the open handoff; one process, one store, minute-long entries. */
export const openNonces = new OpenNonceStore()

/** What a linking handler needs from the request it is serving. */
export interface ComputersContext {
  readonly auth: Authenticator
  readonly config: Config
  /** Origin this request arrived on, as the other side would reach it. */
  readonly origin: string
  /** This listener's pin; absent on a plaintext listener. */
  readonly fingerprint?: string | undefined
  /** Normalized source address, for the pairing lockout counter. */
  readonly address: string
  readonly now: number
}

/** One linked computer, with the reachability observed while the page rendered. */
export interface PeerView {
  readonly peer: PeerRecord
  readonly online: boolean
}

/** The JSON answer one peer endpoint sends. */
export interface PeerAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

/**
 * Parse a peer's JSON answer.
 * @param body - the response text.
 * @returns the object, or undefined when it was not one.
 */
function parseObject(body: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The sentence a peer's own error answer carries, when it carries one.
 * @param response - the answer.
 * @returns the message, if any.
 */
function answerMessage(response: PeerResponse): string | undefined {
  const message = parseObject(response.body)?.message
  return typeof message === 'string' && message !== '' ? message : undefined
}

/**
 * A sentence for a failed call, without leaking internals.
 * @param error - the thrown error.
 */
function callFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'pin-mismatch') return 'The other PC presented a different certificate than the pin expected. Check the pin, or start the link again.'
  if (message === 'timeout') return 'The other PC did not answer in time.'
  if (message === 'response-too-large') return 'The other PC answered with more data than a link call should carry.'
  return `Could not reach the other PC: ${message}`
}

/**
 * Accept a link claimed with this machine's pairing code.
 *
 * Answers JSON for the other relay's operator; the message never names the
 * code or whether it existed, which is the same rule device pairing follows.
 * @param context - the request's relay state.
 * @param fields - the claimed code, the caller's name, origin, pin, and token.
 * @returns the status and body to send.
 */
export async function acceptLink(
  context: ComputersContext,
  fields: Record<string, string>,
): Promise<PeerAnswer> {
  if (!context.config.peersEnabled) {
    return { status: 404, body: { error: 'peers-disabled', message: 'Linking computers is turned off on this relay.' } }
  }
  if (context.fingerprint === undefined) {
    return { status: 409, body: { error: 'tls-required', message: 'This relay is serving plaintext, so a link cannot be pinned.' } }
  }
  if (!context.origin.startsWith('https://') || isLoopbackOrigin(context.origin)) {
    return {
      status: 409,
      body: { error: 'unreachable', message: 'This relay was reached on loopback. Link it through its network address instead.' },
    }
  }
  const url = normalizePeerOrigin(fields.url ?? '')
  if (url === undefined) {
    return { status: 400, body: { error: 'bad-url', message: 'The other PC must offer an https address on the network.' } }
  }
  const fingerprint = (fields.fingerprint ?? '').trim()
  if (!isFingerprint(fingerprint)) {
    return { status: 400, body: { error: 'bad-fingerprint', message: 'The other PC did not offer a usable certificate pin.' } }
  }
  const callbackToken = (fields.callbackToken ?? '').trim()
  if (callbackToken.length < 20) {
    return { status: 400, body: { error: 'bad-token', message: 'The other PC did not offer a usable link token.' } }
  }
  const paired = await context.auth.pairComputer({
    code: fields.code ?? '',
    name: (fields.name ?? '').trim() || 'PC',
    url,
    fingerprint,
    callbackToken,
    address: context.address,
  }, context.now)
  if (paired === 'locked-out') {
    return { status: 429, body: { error: 'rate-limited', message: 'Too many attempts from this computer. Try again later.' } }
  }
  if (paired === undefined) {
    return { status: 403, body: { error: 'pairing-failed', message: 'That code is not valid, has expired, or was already used.' } }
  }
  return {
    status: 200,
    body: {
      linkId: paired.peer.linkId,
      name: peerName(),
      url: context.origin,
      fingerprint: context.fingerprint,
      token: paired.token,
    },
  }
}

/**
 * Link this relay to another one, using a code that relay issued.
 * @param context - this request's relay state.
 * @param input - the other relay's origin and code, and this PC's offered origin.
 * @returns success, or the sentence to show above the form.
 */
export async function connectToPeer(
  context: ComputersContext,
  input: { readonly url: string, readonly code: string, readonly selfUrl: string, readonly pin?: string | undefined },
): Promise<{ readonly ok: true, readonly peer: PeerRecord } | { readonly ok: false, readonly error: string }> {
  if (!context.config.peersEnabled) {
    return { ok: false, error: 'Linking computers is turned off in this relay\'s settings.' }
  }
  if (context.fingerprint === undefined) {
    return { ok: false, error: 'This relay is serving plaintext. Linking needs TLS on both sides.' }
  }
  const peerUrl = normalizePeerOrigin(input.url)
  if (peerUrl === undefined) {
    return { ok: false, error: 'Enter the other PC\'s relay address as https://<address>:<port>.' }
  }
  const selfUrl = normalizePeerOrigin(input.selfUrl)
  if (selfUrl === undefined) {
    return { ok: false, error: 'This PC has no reachable https address to offer the other one.' }
  }
  if (peerUrl === selfUrl) {
    return { ok: false, error: 'That is this PC\'s own address.' }
  }
  const pin = (input.pin ?? '').trim()
  if (pin !== '' && !isFingerprint(pin)) {
    return { ok: false, error: 'A certificate pin is 44 base64 characters, copied from the other PC\'s pairing page.' }
  }
  const callbackToken = mintToken()
  let response: PeerResponse
  try {
    response = await peerRequest({
      origin: peerUrl,
      method: 'POST',
      path: '/relay/link',
      json: {
        code: input.code.trim(),
        name: peerName(),
        url: selfUrl,
        fingerprint: context.fingerprint,
        callbackToken,
      },
      pin: pin === '' ? undefined : pin,
      timeoutMs: context.config.peerTimeoutMs,
    })
  } catch (error) {
    return { ok: false, error: callFailure(error) }
  }
  if (response.status !== 200) {
    return { ok: false, error: answerMessage(response) ?? `The other PC refused the link (HTTP ${String(response.status)}).` }
  }
  const parsed = parseObject(response.body)
  if (parsed === undefined) {
    return { ok: false, error: 'The other PC answered something this relay does not understand.' }
  }
  const token = typeof parsed.token === 'string' ? parsed.token : ''
  const linkId = typeof parsed.linkId === 'string' ? parsed.linkId : ''
  if (token === '' || linkId === '') {
    return { ok: false, error: 'The other PC did not hand back a link token.' }
  }
  const observed = response.fingerprint
  if (observed === undefined) {
    return { ok: false, error: 'The other PC did not present a certificate this relay can pin.' }
  }
  const reportedPin = typeof parsed.fingerprint === 'string' ? parsed.fingerprint : ''
  if (reportedPin !== '' && reportedPin !== observed) {
    return { ok: false, error: 'The other PC reported a different certificate than the one it presented.' }
  }
  const answerUrl = typeof parsed.url === 'string' ? normalizePeerOrigin(parsed.url) : undefined
  if (answerUrl === undefined) {
    return { ok: false, error: 'The other PC answered without an address this relay can reach it at.' }
  }
  const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : 'PC'
  const peer = await context.auth.recordPeer({
    name,
    url: answerUrl,
    fingerprint: observed,
    linkId,
    inboundToken: callbackToken,
    outboundToken: token,
    address: context.address,
  }, context.now)
  return { ok: true, peer }
}

/**
 * List linked computers and whether each answers right now.
 *
 * The probe is made while the page renders, not on a background timer: a
 * laptop that closed its lid shows offline on the next visit without keeping
 * a scheduler alive in the harness process.
 * @param context - this request's relay state.
 * @returns one entry per link, newest first.
 */
export async function listPeers(context: ComputersContext): Promise<PeerView[]> {
  if (!context.config.peersEnabled) return []
  return Promise.all(context.auth.peers.map(async (peer): Promise<PeerView> => {
    try {
      const response = await peerRequest({
        origin: peer.url,
        method: 'GET',
        path: '/relay/peer/status',
        token: peer.outboundToken,
        pin: peer.fingerprint,
        timeoutMs: context.config.peerTimeoutMs,
      })
      const online = response.status === 200
      if (online) await context.auth.touchPeer(peer.id, undefined, context.now)
      return { peer, online }
    } catch {
      return { peer, online: false }
    }
  }))
}

/**
 * The URL the browser should follow to open one linked computer's harness.
 * @param context - this request's relay state.
 * @param peerId - the link to open.
 * @returns the peer's own handoff URL, or a sentence to show instead.
 */
export async function requestOpen(
  context: ComputersContext,
  peerId: string,
): Promise<{ readonly url: string } | { readonly error: string }> {
  if (!context.config.peersEnabled) {
    return { error: 'Linking computers is turned off in this relay\'s settings.' }
  }
  const peer = context.auth.peers.find(entry => entry.id === peerId)
  if (peer === undefined) {
    return { error: 'That computer is not linked any more.' }
  }
  let response: PeerResponse
  try {
    response = await peerRequest({
      origin: peer.url,
      method: 'POST',
      path: '/relay/peer/open',
      token: peer.outboundToken,
      pin: peer.fingerprint,
      timeoutMs: context.config.peerTimeoutMs,
    })
  } catch (error) {
    return { error: callFailure(error) }
  }
  if (response.status !== 200) {
    return { error: answerMessage(response) ?? `The other PC refused to open (HTTP ${String(response.status)}).` }
  }
  const reportedValue = parseObject(response.body)?.url
  const reported = typeof reportedValue === 'string' ? reportedValue : ''
  const target = enterTarget(reported, peer.url)
  if (target === undefined) {
    return { error: 'The other PC answered with a handoff address this relay does not trust.' }
  }
  await context.auth.touchPeer(peer.id, undefined, context.now)
  return { url: target }
}

/**
 * Check a handoff URL names the peer's own enter endpoint, so a compromised or
 * broken peer cannot turn the Open button into an open redirect.
 * @param raw - the URL the peer answered with.
 * @param peerOrigin - the peer's stored origin.
 * @returns the canonical URL, or undefined.
 */
function enterTarget(raw: string, peerOrigin: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.origin !== peerOrigin) return undefined
  if (url.pathname !== '/relay/peer/enter') return undefined
  const nonce = url.searchParams.get('nonce')
  if (nonce === null || nonce === '') return undefined
  return url.toString()
}
