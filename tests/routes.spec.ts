/**
 * First-run setup, driven through a real listener.
 *
 * The bug this file exists for: loopback is classified as the operator and let
 * through without signing in, so `/relay/login` redirected a local browser
 * straight into the harness — past the only form that could set a password.
 * The relay printed "open /relay/login to set one" and that page bounced you.
 * Nothing caught it, because every earlier live check either used curl against
 * `/relay/health` or set the password by POSTing the form directly.
 */
import { createServer, type Server } from 'node:http'
import { createContext, runInContext } from 'node:vm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator } from '../src/auth/index.ts'
import { injectRelayLink } from '../src/badge.ts'
import { Config, type Config as RelayConfig } from '../src/config.ts'
import { startListener, type RelayListener, type RelayRuntime } from '../src/server.ts'
import { injectSecureContextShim } from '../src/secure-context.ts'
import { RelayStore } from '../src/state.ts'

let upstream: Server
let relay: RelayListener
let store: RelayStore
let auth: Authenticator
let dir: string
let base: string

/** One request to the relay, without following redirects. */
async function get(path: string): Promise<{ status: number, location: string | null, body: string }> {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' })
  return { status: response.status, location: response.headers.get('location'), body: await response.text() }
}

/** One form POST to the relay, without following redirects. */
async function post(path: string, fields: Record<string, string>): Promise<{ status: number, location: string | null, body: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: response.status, location: response.headers.get('location'), body: await response.text() }
}

/** One JSON claim against `/relay/pair`, as a native client sends it. */
async function claim(code: string): Promise<{ status: number, retryAfter: string | null, body: string }> {
  const response = await fetch(`${base}/relay/pair`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: 'Test device' }),
  })
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.text(),
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-routes-'))
  store = await RelayStore.open(dir)
  upstream = createServer((_req, res) => { res.writeHead(200); res.end('harness') })
  await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', () => { resolve() }) })
  const upstreamAddress = upstream.address()
  const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress !== null ? upstreamAddress.port : 0

  const config = Config({ stateDir: dir, port: 0, tls: 'off', mdns: false }) as RelayConfig
  auth = new Authenticator(store, config)
  const runtime: RelayRuntime = {
    auth,
    config,
    target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 },
    log: () => undefined,
  }
  relay = await startListener({ runtime, bind: '127.0.0.1', port: 0, authorities: ['127.0.0.1', 'localhost'] })
  base = `http://127.0.0.1:${String(relay.port)}`
})

afterEach(async () => {
  await relay.close()
  auth.dispose()
  await store.close()
  await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => { resolve() }) })
  await rm(dir, { recursive: true, force: true })
})

describe('first-run setup from the machine running the harness', () => {
  it('sends the sign-in page to the setup page while no password exists', async () => {
    const answer = await get('/relay/login')
    expect(answer.status).toBe(303)
    expect(answer.location).toBe('/relay/password')
  })

  it('serves a setup form that actually sets a password', async () => {
    const form = await get('/relay/password')
    expect(form.status).toBe(200)
    expect(form.body).toContain('Set a password')
    expect(auth.hasPassword).toBe(false)

    const submitted = await post('/relay/password', { password: 'a-long-test-password', confirm: 'a-long-test-password' })
    expect(submitted.status).toBe(303)
    expect(auth.hasPassword).toBe(true)
  })

  it('refuses a short password and says why, without losing the form', async () => {
    const answer = await post('/relay/password', { password: 'short', confirm: 'short' })
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('at least 10 characters')
    expect(auth.hasPassword).toBe(false)
  })

  it('refuses a mismatched confirmation', async () => {
    const answer = await post('/relay/password', { password: 'a-long-test-password', confirm: 'something-else' })
    expect(answer.status).toBe(400)
    expect(answer.body).toContain('do not match')
    expect(auth.hasPassword).toBe(false)
  })

  it('offers to replace the password once one is set', async () => {
    await auth.setPassword('a-long-test-password')
    const form = await get('/relay/password')
    expect(form.status).toBe(200)
    expect(form.body).toContain('Change the password')
  }, 20_000)
})

describe('the operator is not asked to sign in', () => {
  it('passes a local request through to the harness', async () => {
    await auth.setPassword('a-long-test-password')
    const answer = await get('/')
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('harness')
  }, 20_000)

  it('redirects the sign-in page onward once a password exists', async () => {
    await auth.setPassword('a-long-test-password')
    const answer = await get('/relay/login?next=/workspace')
    expect(answer.status).toBe(303)
    expect(answer.location).toBe('/workspace')
  }, 20_000)
})

describe('the devices page', () => {
  it('reports that no password is set, and links to the page that sets one', async () => {
    const answer = await get('/relay/devices')
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('not set')
    expect(answer.body).toContain('/relay/password')
  })

  it('reports a password once it exists', async () => {
    await auth.setPassword('a-long-test-password')
    const answer = await get('/relay/devices')
    expect(answer.body).toContain('Change the password')
  }, 20_000)
})

describe('two rows for one phone can be told apart', () => {
  /** Enrol one device whose name, address, and id are pinned by the caller. */
  async function enrol(id: string, createdAt: number, lastSeenAt?: number): Promise<void> {
    await store.update((draft) => {
      draft.devices[id] = {
        id,
        name: 'samsung SM-S731B',
        tokenHash: `hash-${id}`,
        createdAt,
        expiresAt: createdAt + 30 * 24 * 60 * 60 * 1000,
        ...lastSeenAt !== undefined && { lastSeenAt, lastAddress: '192.168.0.85' },
      }
    })
  }

  it('says when each device was paired, next to when it was last seen', async () => {
    // Two pairings of one handset, two hours apart, the stale one never used:
    // every other column on the page reads the same for both rows.
    const now = Date.now()
    const older = now - 2 * 60 * 60 * 1000
    await enrol('aaaaaaaa1111', older, older)
    await enrol('bbbbbbbb2222', now)

    const answer = await get('/relay/devices')
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('paired 2 h ago')
    expect(answer.body).toContain('paired just now')
    expect(answer.body).toContain('last seen 2 h ago')
    expect(answer.body).toContain('last seen never')
  })

  it('shows a short tail of each id, so equal names are distinguishable', async () => {
    const now = Date.now()
    await enrol('aaaaaaaa1111', now, now)
    await enrol('bbbbbbbb2222', now, now)

    const answer = await get('/relay/devices')
    expect(answer.body.match(/samsung SM-S731B/g)).toHaveLength(2)
    expect(answer.body).toContain('>1111<')
    expect(answer.body).toContain('>2222<')
  })
})

describe('the link into the harness UI', () => {
  it('injects one anchor before the closing body tag', () => {
    const injected = injectRelayLink('<!doctype html><html><body><div id="root"></div></body></html>')
    expect(injected).toContain('href="/relay/devices"')
    expect(injected.indexOf('dsh-relay-link')).toBeLessThan(injected.indexOf('</body>'))
  })

  it('is idempotent — the tap runs on every index response, including SPA fallbacks', () => {
    const once = injectRelayLink('<body></body>')
    expect(injectRelayLink(once)).toBe(once)
  })

  it('leaves a document with no body element alone rather than throwing', () => {
    expect(injectRelayLink('not html at all')).toBe('not html at all')
  })

  it('styles itself from the harness theme tokens, with a fallback for first paint', () => {
    expect(injectRelayLink('<body></body>')).toContain('var(--dsw-alias-bg-layer-2, #fff)')
  })

  it('needs no script — the relative href is answered by the redirect route', () => {
    expect(injectRelayLink('<body></body>')).not.toContain('<script')
  })
})

/** A crypto object carrying only what a browser exposes on an insecure origin. */
function insecureCrypto(): { getRandomValues: (into: Uint8Array) => Uint8Array, randomUUID?: () => string } {
  let next = 0
  return {
    getRandomValues: (into) => {
      for (let at = 0; at < into.length; at += 1) into[at] = (next += 37) & 0xff
      return into
    },
  }
}

/** Stands in for the function a secure context already provides. */
const browserRandomUuid = (): string => 'the-browser-implementation'

describe('minting ids on a page the browser does not call secure', () => {
  /** A document shaped like the one the frontend actually serves. */
  const index = '<!doctype html><html><head><meta charset="utf-8">'
    + '<script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>'

  /**
   * Execute the injected script against one crypto object.
   * @param crypto - the object the script will find at `globalThis.crypto`.
   * @returns that same object, after the script has had its way with it.
   */
  function run(crypto: unknown): { randomUUID?: () => string } {
    const script = /<script id="dsh-relay-secure-context">([\s\S]*?)<\/script>/.exec(
      injectSecureContextShim(index),
    )?.[1]
    expect(script).toBeDefined()
    runInContext(script ?? '', createContext({ crypto }))
    return crypto as { randomUUID?: () => string }
  }

  it('injects one classic script after the opening head tag', () => {
    const injected = injectSecureContextShim(index)
    expect(injected).toContain('<script id="dsh-relay-secure-context">')
    // Ahead of the deferred module, which is the only ordering that matters:
    // the module runs after parsing, this runs during it.
    expect(injected.indexOf('dsh-relay-secure-context')).toBeLessThan(injected.indexOf('/assets/index.js'))
  })

  it('is idempotent — the tap runs on every index response, including SPA fallbacks', () => {
    const once = injectSecureContextShim(index)
    expect(injectSecureContextShim(once)).toBe(once)
  })

  it('falls back to the body element when a document carries no head', () => {
    expect(injectSecureContextShim('<body></body>')).toContain('dsh-relay-secure-context')
  })

  it('leaves a document with neither element alone, rather than pushing the doctype into quirks mode', () => {
    expect(injectSecureContextShim('not html at all')).toBe('not html at all')
  })

  it('mints an RFC 4122 version 4 UUID from getRandomValues', () => {
    const minted = run(insecureCrypto()).randomUUID?.()
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('mints a different id each time, or every RPC would correlate to the same call', () => {
    const crypto = run(insecureCrypto())
    expect(crypto.randomUUID?.()).not.toBe(crypto.randomUUID?.())
  })

  it('defines nothing where the real function exists, so TLS and loopback are untouched', () => {
    const crypto = run({ ...insecureCrypto(), randomUUID: browserRandomUuid })
    expect(crypto.randomUUID).toBe(browserRandomUuid)
  })

  it('defines nothing without getRandomValues either — a Math.random id would only look like it worked', () => {
    expect(run({}).randomUUID).toBeUndefined()
  })

  it('survives a crypto object that refuses the definition', () => {
    const frozen = Object.freeze(insecureCrypto())
    expect(() => run(frozen)).not.toThrow()
    expect(frozen.randomUUID).toBeUndefined()
  })

  it('survives a page with no crypto at all, because it runs inside the harness response', () => {
    expect(() => run(undefined)).not.toThrow()
  })
})

describe('a reverse proxy on loopback is not the operator', () => {
  // What Funnel, Serve, nginx, and Caddy actually send: a loopback TCP peer
  // whose requests carry the address they are forwarding for.
  const proxied = { 'x-forwarded-for': '203.0.113.7' }

  it('answers the forwarded request with the gate, not the harness', async () => {
    const response = await fetch(`${base}/`, { headers: proxied, redirect: 'manual' })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toBe('harness')
  })

  it('sends a forwarded browser to sign in', async () => {
    await auth.setPassword('a-long-test-password')
    const response = await fetch(`${base}/`, { headers: { ...proxied, accept: 'text/html' }, redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/relay/login?next=%2F')
  }, 20_000)

  it('keeps first-run password setup away from the proxy', async () => {
    const response = await fetch(`${base}/relay/password`, { headers: proxied, redirect: 'manual' })
    expect(response.status).toBe(403)
    expect(auth.hasPassword).toBe(false)
  })

  it('throttles the proxy, which the operator never is', async () => {
    const upstreamAddress = upstream.address()
    const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress !== null ? upstreamAddress.port : 0
    const config = Config({ stateDir: dir, port: 0, tls: 'off', mdns: false, rateLimitPerMinute: 1 }) as RelayConfig
    const throttled = new Authenticator(store, config)
    const listener = await startListener({
      runtime: { auth: throttled, config, target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 }, log: () => undefined },
      bind: '127.0.0.1',
      port: 0,
      authorities: ['127.0.0.1', 'localhost'],
    })
    try {
      const origin = `http://127.0.0.1:${String(listener.port)}`
      expect((await fetch(`${origin}/`, { headers: proxied })).status).toBe(403)
      expect((await fetch(`${origin}/`, { headers: proxied })).status).toBe(429)
      // The operator's own requests never enter the throttle the proxy filled.
      expect((await fetch(`${origin}/`)).status).toBe(200)
    } finally {
      await listener.close()
      throttled.dispose()
    }
  })
})

describe('a locked-out caller is told to wait, not that the code was wrong', () => {
  it('answers a pairing lockout with 429 and a Retry-After', async () => {
    auth.pairing.issue(8, 300_000, Date.now())
    // Default maxFailedAttempts is 5; spend them on a code that cannot match.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await claim('00000000')
      expect(refused.status).toBe(403)
      expect(refused.body).toContain('pairing-failed')
    }

    // The sixth is refused for a different reason, and says so. Reporting it as pairing-failed
    // sends someone to reload the pairing page, which spends another attempt proving the same
    // thing — the code is not what is wrong.
    const locked = await claim('00000000')
    expect(locked.status).toBe(429)
    expect(locked.body).toContain('rate-limited')
    expect(Number(locked.retryAfter)).toBeGreaterThan(0)
  })

  it('answers a sign-in lockout with a Retry-After, as the client contract promises', async () => {
    await post('/relay/password', { password: 'a-long-test-password', confirm: 'a-long-test-password' })
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post('/relay/login', { password: 'wrong-password-here' })
    }

    const response = await fetch(`${base}/relay/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'a-long-test-password' }).toString(),
    })
    expect(response.status).toBe(429)
    // The rate limiter set this header and the lockout did not, which are indistinguishable from
    // outside — so a client that trusted the documented header busy-retried against a lockout.
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})
