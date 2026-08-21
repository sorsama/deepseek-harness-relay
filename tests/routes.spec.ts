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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator } from '../src/auth/index.ts'
import { Config, type Config as RelayConfig } from '../src/config.ts'
import { startListener, type RelayListener, type RelayRuntime } from '../src/server.ts'
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
