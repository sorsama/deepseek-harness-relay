/**
 * What happens to a `/relay` request that arrives on the harness's own web
 * server.
 *
 * This is the decision that broke the desktop app once: every path redirected
 * to the relay's TLS listener, and an Electron main-frame navigation onto that
 * self-signed certificate is fatal. The rules pinned here are narrow on
 * purpose — documents are served, only the mobile discovery probe redirects,
 * and nothing is served to a request that is not addressed to this machine.
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { harnessOriginAction, harnessOriginTrusted } from '../src/harness-origin.ts'

/** Build the request facts the decision reads. */
function request(init: {
  method?: string
  url?: string
  accept?: string
  host?: string
  origin?: string
  site?: string
} = {}): IncomingMessage {
  return {
    method: init.method ?? 'GET',
    url: init.url ?? '/relay/devices',
    headers: {
      host: init.host ?? '127.0.0.1:63109',
      ...init.accept === undefined ? {} : { accept: init.accept },
      ...init.origin === undefined ? {} : { origin: init.origin },
      ...init.site === undefined ? {} : { 'sec-fetch-site': init.site },
    },
  } as unknown as IncomingMessage
}

describe('a document navigation is served, never redirected', () => {
  it('serves the desktop window changing page in place', () => {
    expect(harnessOriginAction(request({ accept: 'text/html,application/xhtml+xml' }), true)).toBe('serve')
  })

  it('serves even the health path when a browser asked for a page', () => {
    expect(harnessOriginAction(request({ url: '/relay/health', accept: 'text/html' }), true)).toBe('serve')
  })
})

describe('the mobile discovery probe still redirects', () => {
  it('answers /relay/health to an API client with a redirect', () => {
    expect(harnessOriginAction(request({ url: '/relay/health', accept: '*/*' }), true)).toBe('redirect')
    expect(harnessOriginAction(request({ url: '/relay/health' }), true)).toBe('redirect')
  })

  it('does not redirect any other API path', () => {
    expect(harnessOriginAction(request({ url: '/relay/devices', accept: 'application/json' }), true)).toBe('serve')
  })

  it('serves a form post, which a redirect would rewrite into a GET', () => {
    expect(harnessOriginAction(request({ method: 'POST', url: '/relay/pair', accept: 'text/html' }), true)).toBe('serve')
  })
})

describe('nothing is served to an unaddressed or untrusted request', () => {
  it('refuses a non-loopback peer', () => {
    expect(harnessOriginAction(request({ accept: 'text/html' }), false)).toBe('refuse')
  })

  it('refuses a request whose Host is not loopback, the DNS-rebinding shape', () => {
    expect(harnessOriginTrusted(request({ host: 'attacker.example:63109' }))).toBe(false)
    expect(harnessOriginAction(request({ host: 'attacker.example:63109', accept: 'text/html' }), true)).toBe('refuse')
  })

  it('refuses a cross-site form post', () => {
    expect(harnessOriginTrusted(request({
      method: 'POST', origin: 'https://evil.example', site: 'cross-site',
    }))).toBe(false)
    expect(harnessOriginTrusted(request({ method: 'POST', site: 'cross-site' }))).toBe(false)
  })

  it('accepts the desktop shell and loopback browsers', () => {
    expect(harnessOriginTrusted(request({ origin: 'dsh-app://app' }))).toBe(true)
    expect(harnessOriginTrusted(request({ origin: 'http://127.0.0.1:63109' }))).toBe(true)
    expect(harnessOriginTrusted(request({ origin: 'http://localhost:63109' }))).toBe(true)
    // A plain navigation carries no Origin at all.
    expect(harnessOriginTrusted(request())).toBe(true)
  })
})
