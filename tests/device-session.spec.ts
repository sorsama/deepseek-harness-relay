/**
 * A paired device's WebView: the token-to-cookie handoff, what that cookie may
 * and may not do, and the one settings namespace a remote client reaches when
 * the configuration plane is pinned to loopback.
 *
 * Every remote request here comes from this test over loopback carrying
 * `X-Forwarded-For`, which the relay treats as network traffic: it needs a
 * credential like any phone would. A request without that header is the
 * operator at the machine, and is used only where the operator is the point.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, type Socket } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator, DEVICE_COOKIE, SESSION_COOKIE } from '../src/auth/index.ts'
import { HANDOFF_TTL_MS, HandoffCodes } from '../src/auth/handoff.ts'
import { injectRelayLink } from '../src/badge.ts'
import { Config, plainConfig, type Config as RelayConfig } from '../src/config.ts'
import { filterDescribeAnswer, rebuildScopedRequest } from '../src/proxy/scoped-settings.ts'
import { reachesScopedSettings, startListener, type RelayListener, type RelayRuntime } from '../src/server.ts'
import { RelayStore } from '../src/state.ts'
import { certificateSans, loadCertificate } from '../src/tls.ts'

/** The RFC 6455 handshake GUID, so the fake upstream can answer a real upgrade. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** What makes a loopback request network traffic to the relay. */
const REMOTE = { 'x-forwarded-for': '192.168.1.50' } as const

/** How the fake harness answers `settings/describe`. */
type DescribeMode = 'normal' | 'refusal' | 'not-json' | 'multipart' | 'no-namespaces' | 'gzip'

/** One request the fake harness received. */
interface Received {
  readonly method: string
  readonly url: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

let upstream: Server
let upstreamPort: number
const upstreamSockets = new Set<Duplex>()
let received: Received[] = []
let describeMode: DescribeMode = 'normal'

let dir: string
let store: RelayStore
let auth: Authenticator
let relay: RelayListener
let extraListeners: RelayListener[] = []
let base: string

/** Every namespace the fake harness describes; only one may ever reach a remote client. */
const ALL_NAMESPACES = [
  { ns: 'relay', revision: 3, value: { privilegedMethods: 'loopback-only' } },
  { ns: 'ui-sync', revision: 7, value: { targets: { 'dsh-pet|shell.overlay|pet': 'phone' } } },
  { ns: 'llm', revision: 1, value: { apiKey: '[redacted]', baseUrl: 'https://example.invalid' } },
]

/** Stand in for the harness: record every request, answer settings calls like the real one. */
function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body })
      const rpcId = (() => {
        try { return (JSON.parse(body) as { rpcId?: string }).rpcId ?? 'none' } catch { return 'none' }
      })()
      if (req.url === '/api/settings/describe') {
        answerDescribe(res, rpcId)
        return
      }
      if (req.url === '/api/settings/mutate') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: ALL_NAMESPACES[1] } }))
        return
      }
      if (req.url?.startsWith('/api/') === true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: 'forwarded' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('harness')
    })
  })
  upstream.on('connection', (socket) => { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)) })
  upstream.on('upgrade', (req, socket: Duplex) => {
    received.push({ method: 'UPGRADE', url: req.url ?? '/', headers: req.headers, body: '' })
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}${WS_GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    // One frame the relay must carry down, and then the downlink stays open,
    // the way the harness's mux does.
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
  })
  return new Promise((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      const address = upstream.address()
      upstreamPort = typeof address === 'object' && address !== null ? address.port : 0
      resolve()
    })
  })
}

/** The fake harness's describe answer, in whichever shape the test asked for. */
function answerDescribe(res: ServerResponse, rpcId: string): void {
  const success = { type: 'server-response', rpcId, result: { ok: true, value: { writable: true, hasDocument: true, namespaces: ALL_NAMESPACES } } }
  switch (describeMode) {
    case 'normal':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(success))
      return
    case 'refusal':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'gateway/internal', message: 'settings service is absent' } } }))
      return
    case 'not-json':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`${JSON.stringify(success)} trailing`)
      return
    case 'multipart':
      res.writeHead(200, { 'content-type': 'multipart/form-data; boundary=x' })
      res.end(JSON.stringify(success))
      return
    case 'no-namespaces':
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { writable: true } } }))
      return
    case 'gzip':
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
      res.end(JSON.stringify(success))
  }
}

/** A resolved config in plain values, loopback-only unless a test says otherwise. */
function configFor(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return plainConfig(Config({
    stateDir: dir,
    port: 0,
    tls: 'off',
    mdns: false,
    privilegedMethods: 'loopback-only',
    ...overrides,
  }) as Parameters<typeof plainConfig>[0])
}

/** Start the relay under test, replacing the one beforeEach started. */
async function restartRelay(overrides: Partial<RelayConfig> = {}): Promise<RelayRuntime> {
  await relay.close()
  auth.dispose()
  const config = configFor(overrides)
  auth = new Authenticator(store, config)
  const runtime: RelayRuntime = {
    auth,
    config,
    target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 },
    log: () => undefined,
  }
  relay = await startListener({ runtime, bind: '127.0.0.1', port: 0, authorities: ['127.0.0.1', 'localhost'] })
  base = `http://127.0.0.1:${String(relay.port)}`
  return runtime
}

/** Pair one device the way `/relay/pair` does, and return its token and id. */
async function pairDevice(name = 'Phone'): Promise<{ token: string, deviceId: string }> {
  const { code } = auth.pairing.issue(8, 300_000, Date.now())
  const paired = await auth.pair({ code, name, address: '203.0.113.9' }, Date.now())
  if (paired === undefined || paired === 'locked-out') throw new Error('pairing failed in the fixture')
  return { token: paired.token, deviceId: paired.device.id }
}

/** One request to the relay, without following redirects. */
async function call(path: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<{
  status: number
  headers: Headers
  text: string
}> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: init.headers,
    body: init.body,
  })
  return { status: response.status, headers: response.headers, text: await response.text() }
}

/** Ask for a handoff code with a bearer token. */
async function openSession(token: string, body?: Record<string, string>): Promise<{ status: number, json: Record<string, unknown> }> {
  const answer = await call('/relay/session/open', {
    method: 'POST',
    headers: {
      ...REMOTE,
      authorization: `Bearer ${token}`,
      ...body === undefined ? {} : { 'content-type': 'application/json' },
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: answer.status, json: JSON.parse(answer.text) as Record<string, unknown> }
}

/** Run the whole handoff and return the `name=value` pair the WebView would now send. */
async function deviceCookie(token: string): Promise<string> {
  const opened = await openSession(token)
  expect(opened.status).toBe(200)
  const entered = await call(String(opened.json.path), { headers: { ...REMOTE } })
  expect(entered.status).toBe(303)
  const setCookie = entered.headers.get('set-cookie') ?? ''
  const pair = setCookie.split(';', 1)[0] ?? ''
  expect(pair.startsWith(`${DEVICE_COOKIE}=`)).toBe(true)
  return pair
}

/** A unary RPC envelope, as the web client posts it. */
function envelope(method: string, args: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'client-request', rpcId: `rpc-${randomBytes(4).toString('hex')}`, method, payload: { args }, ...extra })
}

/** Post one RPC through the relay. */
async function rpc(method: string, body: string, credential: Record<string, string>): Promise<{ status: number, text: string }> {
  const answer = await call(`/api/${method}`, {
    method: 'POST',
    headers: { ...REMOTE, ...credential, 'content-type': 'application/json' },
    body,
  })
  return { status: answer.status, text: answer.text }
}

/** Requests the fake harness saw on one path. */
function seenAt(url: string): Received[] {
  return received.filter(entry => entry.url === url)
}

/** An upgraded socket held open, and a promise that settles when it closes. */
interface OpenSocket {
  readonly socket: Socket
  readonly closed: Promise<void>
}

/** Open a WebSocket through the relay and resolve once the upstream's frame arrives. */
function openUpgrade(port: number, headers: Record<string, string>): Promise<OpenSocket> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /api/remote.mux HTTP/1.1',
        `Host: 127.0.0.1:${String(port)}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '', '',
      ].join('\r\n'))
    })
    const closed = new Promise<void>((done) => { socket.once('close', () => { done() }) })
    let text = ''
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('binary')
      if (text.includes('101 Switching Protocols') && text.includes('hi')) {
        // Established downlinks are idle by design; only the handshake had a deadline.
        socket.setTimeout(0)
        resolve({ socket, closed })
      }
      if (text.startsWith('HTTP/1.1 403')) reject(new Error('upgrade refused'))
    })
    socket.on('error', () => undefined)
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')) })
  })
}

/** Whether a socket is still open after the event loop has had a chance to close it. */
async function stillOpen(open: OpenSocket): Promise<boolean> {
  const outcome = await Promise.race([
    open.closed.then(() => 'closed' as const),
    new Promise<'open'>((resolve) => { setTimeout(() => { resolve('open') }, 150) }),
  ])
  return outcome === 'open'
}

beforeEach(async () => {
  received = []
  describeMode = 'normal'
  extraListeners = []
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-device-session-'))
  store = await RelayStore.open(dir)
  await startUpstream()
  const config = configFor()
  auth = new Authenticator(store, config)
  relay = await startListener({
    runtime: { auth, config, target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 }, log: () => undefined },
    bind: '127.0.0.1',
    port: 0,
    authorities: ['127.0.0.1', 'localhost'],
  })
  base = `http://127.0.0.1:${String(relay.port)}`
})

afterEach(async () => {
  for (const listener of extraListeners) await listener.close()
  await relay.close()
  auth.dispose()
  await store.close()
  for (const socket of upstreamSockets) socket.destroy()
  await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => { resolve() }) })
  await rm(dir, { recursive: true, force: true })
})

describe('device to WebView session handoff', () => {
  it('trades a bearer token for a one-time code that lands the WebView in the harness', async () => {
    const { token } = await pairDevice()
    const before = Date.now()
    const opened = await openSession(token)
    expect(opened.status).toBe(200)
    const code = String(opened.json.code)
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(opened.json.path).toBe(`/relay/session/enter?code=${code}`)
    expect(opened.json.url).toBe(`${base}/relay/session/enter?code=${code}`)
    expect(Number(opened.json.expiresAt)).toBeGreaterThanOrEqual(before + HANDOFF_TTL_MS)
    expect(Number(opened.json.expiresAt)).toBeLessThanOrEqual(Date.now() + HANDOFF_TTL_MS)

    const entered = await call(String(opened.json.path), { headers: { ...REMOTE } })
    expect(entered.status).toBe(303)
    expect(entered.headers.get('location')).toBe('/')
    expect(entered.headers.get('referrer-policy')).toBe('no-referrer')
    const setCookie = entered.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(new RegExp(`^${DEVICE_COOKIE}=`))
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    // Plain HTTP here, so no Secure flag; the TLS case is below.
    expect(setCookie).not.toContain('Secure')
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
    expect(maxAge).toBeGreaterThan(43_000)
    expect(maxAge).toBeLessThanOrEqual(43_200)

    const cookie = setCookie.split(';', 1)[0] ?? ''
    const page = await call('/', { headers: { ...REMOTE, cookie, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(page.text).toBe('harness')
    // The relay's cookie authenticates to the relay and stops there.
    expect(String(seenAt('/').at(-1)?.headers.cookie ?? '')).not.toContain(DEVICE_COOKIE)
  })

  it('carries the page, the API, and the WebSocket on the cookie alone', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const api = await rpc('session/list', envelope('session/list', {}), { cookie })
    expect(api.status).toBe(200)
    expect(api.text).toContain('forwarded')
    const socket = await openUpgrade(relay.port, { ...REMOTE, cookie })
    expect(await stillOpen(socket)).toBe(true)
    socket.socket.destroy()
  })

  it('lands on the path the app asked for, and never off this origin', async () => {
    const { token } = await pairDevice()
    const landing = async (next: string): Promise<string | null> => {
      const opened = await openSession(token, { next })
      const entered = await call(String(opened.json.path), { headers: { ...REMOTE } })
      return entered.headers.get('location')
    }
    expect(await landing('/?session=abc')).toBe('/?session=abc')
    expect(await landing('//evil.example/x')).toBe('/')
    expect(await landing('/\\evil.example')).toBe('/')
    expect(await landing('https://evil.example/')).toBe('/')
    expect(await landing('/ok\r\nset-cookie: x=y')).toBe('/')
    expect(await landing(`/${'a'.repeat(3000)}`)).toBe('/')
  })

  it('spends the code on first use', async () => {
    const { token } = await pairDevice()
    const opened = await openSession(token)
    expect((await call(String(opened.json.path), { headers: { ...REMOTE } })).status).toBe(303)
    const again = await call(String(opened.json.path), { headers: { ...REMOTE } })
    expect(again.status).toBe(403)
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('refuses an expired code', async () => {
    const { deviceId } = await pairDevice()
    // Issued straight into the store a minute and more ago: the device itself
    // is newer than that, so the open route would refuse to backdate it.
    const stale = auth.handoffs.issue(deviceId, '/', Date.now() - HANDOFF_TTL_MS - 1000)
    const answer = await call(`/relay/session/enter?code=${stale.code}`, { headers: { ...REMOTE } })
    expect(answer.status).toBe(403)
    expect(answer.headers.get('set-cookie')).toBeNull()
  })

  it('refuses a code nobody issued', async () => {
    const answer = await call(`/relay/session/enter?code=${randomBytes(24).toString('base64url')}`, {
      headers: { ...REMOTE, accept: 'application/json' },
    })
    expect(answer.status).toBe(403)
    expect(answer.text).toContain('handoff-failed')
  })

  it('refuses a code whose device was unpaired before the WebView used it', async () => {
    const { token, deviceId } = await pairDevice()
    const opened = await openSession(token)
    await auth.revoke(deviceId, Date.now())
    const answer = await call(String(opened.json.path), { headers: { ...REMOTE } })
    expect(answer.status).toBe(403)
    expect(answer.headers.get('set-cookie')).toBeNull()
  })

  it('opens only for a bearer token, never for a cookie or the operator', async () => {
    const { token, deviceId } = await pairDevice()
    const cookie = await deviceCookie(token)
    const asCookie = await call('/relay/session/open', { method: 'POST', headers: { ...REMOTE, cookie } })
    expect(asCookie.status).toBe(403)

    const signIn = auth.sessionGrant(Date.now())
    const asSignIn = await call('/relay/session/open', {
      method: 'POST',
      headers: { ...REMOTE, cookie: `${SESSION_COOKIE}=${encodeURIComponent(signIn.cookie)}` },
    })
    expect(asSignIn.status).toBe(403)

    const asOperator = await call('/relay/session/open', { method: 'POST' })
    expect(asOperator.status).toBe(403)

    const anonymous = await call('/relay/session/open', { method: 'POST', headers: { ...REMOTE } })
    expect(anonymous.status).toBe(403)

    await auth.revoke(deviceId, Date.now())
    expect((await openSession(token)).status).toBe(403)
  })

  it('never outlives the device token', async () => {
    const { token, deviceId } = await pairDevice()
    await store.update((draft) => {
      const device = draft.devices[deviceId]
      if (device !== undefined) device.expiresAt = Date.now() + 120_000
    })
    const opened = await openSession(token)
    const entered = await call(String(opened.json.path), { headers: { ...REMOTE } })
    const maxAge = Number(/Max-Age=(\d+)/.exec(entered.headers.get('set-cookie') ?? '')?.[1])
    expect(maxAge).toBeGreaterThan(100)
    expect(maxAge).toBeLessThanOrEqual(120)
  })
})

describe('unpairing ends the WebView session', () => {
  it('refuses the cookie on the next request', async () => {
    const { token, deviceId } = await pairDevice()
    const cookie = await deviceCookie(token)
    expect((await call('/', { headers: { ...REMOTE, cookie } })).status).toBe(200)
    await auth.revoke(deviceId, Date.now())
    expect((await call('/', { headers: { ...REMOTE, cookie } })).status).toBe(403)
    const document = await call('/', { headers: { ...REMOTE, cookie, accept: 'text/html' } })
    expect(document.status).toBe(303)
    expect(document.headers.get('location')).toBe('/relay/login?next=%2F')
  })

  it('closes that device\'s open WebSockets, and only that device\'s', async () => {
    const phone = await pairDevice('Phone')
    const tablet = await pairDevice('Tablet')
    const phoneSocket = await openUpgrade(relay.port, { ...REMOTE, cookie: await deviceCookie(phone.token) })
    const phoneBearer = await openUpgrade(relay.port, { ...REMOTE, authorization: `Bearer ${phone.token}` })
    const tabletSocket = await openUpgrade(relay.port, { ...REMOTE, authorization: `Bearer ${tablet.token}` })
    const operatorSocket = await openUpgrade(relay.port, {})

    await auth.revoke(phone.deviceId, Date.now())
    await phoneSocket.closed
    await phoneBearer.closed
    expect(await stillOpen(tabletSocket)).toBe(true)
    expect(await stillOpen(operatorSocket)).toBe(true)

    // Sign out everywhere takes every remote downlink and leaves the
    // operator's own loopback one alone.
    await auth.signOutEverywhere()
    await tabletSocket.closed
    expect(await stillOpen(operatorSocket)).toBe(true)
    operatorSocket.socket.destroy()
  })

  it('dies with sign out everywhere', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    await auth.signOutEverywhere()
    expect((await call('/', { headers: { ...REMOTE, cookie } })).status).toBe(403)
  })
})

describe('what the WebView cookie is', () => {
  it('is the device, not the operator', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const headers = { ...REMOTE, cookie, accept: 'application/json' }
    expect((await call('/relay/devices', { headers })).status).toBe(403)
    expect((await call('/relay/computers', { headers })).status).toBe(403)
    expect((await call('/relay/pair/new', { method: 'POST', headers })).status).toBe(403)
    expect((await call('/relay/signout-everywhere', { method: 'POST', headers })).status).toBe(403)
    expect(auth.devices).toHaveLength(1)
  })

  it('means nothing under the sign-in cookie\'s name', async () => {
    const { token } = await pairDevice()
    const value = (await deviceCookie(token)).slice(DEVICE_COOKIE.length + 1)
    const relabelled = `${SESSION_COOKIE}=${value}`
    expect((await call('/', { headers: { ...REMOTE, cookie: relabelled } })).status).toBe(403)
    expect((await call('/relay/devices', { headers: { ...REMOTE, cookie: relabelled } })).status).toBe(403)
  })

  it('does not accept a sign-in cookie under its own name either', async () => {
    const signIn = auth.sessionGrant(Date.now())
    const relabelled = `${DEVICE_COOKIE}=${encodeURIComponent(signIn.cookie)}`
    expect((await call('/', { headers: { ...REMOTE, cookie: relabelled } })).status).toBe(403)
  })

  it('is refused on the plain compatibility listener', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const config = configFor({ compat: { addressGrants: false, addressGrantTtlMs: 86_400_000, plainPort: 1 } })
    const compat = await startListener({
      runtime: { auth, config, target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 }, log: () => undefined },
      bind: '127.0.0.1',
      port: 0,
      compat: true,
      authorities: ['127.0.0.1', 'localhost'],
    })
    extraListeners.push(compat)
    const plain = `http://127.0.0.1:${String(compat.port)}`
    expect((await fetch(`${plain}/`, { headers: { ...REMOTE, cookie } })).status).toBe(403)
    // The bearer token still works there, which is what that listener is for.
    expect((await fetch(`${plain}/`, { headers: { ...REMOTE, authorization: `Bearer ${token}` } })).status).toBe(200)
  })

  it('is marked Secure when the relay serves TLS', async () => {
    const material = await loadCertificate({
      mode: 'self-signed',
      dir,
      certPath: '',
      keyPath: '',
      sans: certificateSans([]),
      existing: undefined,
    })
    if (material === undefined) throw new Error('the suite needs a certificate')
    const config = configFor({ tls: 'self-signed' })
    const tls = await startListener({
      runtime: { auth, config, target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 }, log: () => undefined },
      bind: '127.0.0.1',
      port: 0,
      tls: material,
      authorities: ['127.0.0.1', 'localhost'],
    })
    extraListeners.push(tls)
    const { token } = await pairDevice()

    const tlsCall = (method: string, path: string, headers: Record<string, string>): Promise<{ status: number, headers: IncomingMessage['headers'], body: string }> =>
      new Promise((resolve, reject) => {
        const request = httpsRequest({
          host: '127.0.0.1',
          port: tls.port,
          method,
          path,
          rejectUnauthorized: false,
          headers: { ...REMOTE, ...headers },
        }, (response) => {
          let body = ''
          response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          response.on('end', () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body }) })
        })
        request.on('error', reject)
        request.end()
      })

    const opened = await tlsCall('POST', '/relay/session/open', { authorization: `Bearer ${token}` })
    expect(opened.status).toBe(200)
    const json = JSON.parse(opened.body) as { path: string, url: string }
    expect(json.url).toBe(`https://127.0.0.1:${String(tls.port)}${json.path}`)
    const entered = await tlsCall('GET', json.path, {})
    expect(entered.status).toBe(303)
    const setCookie = (entered.headers['set-cookie'] ?? []).join('\n')
    expect(setCookie).toContain(`${DEVICE_COOKIE}=`)
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
  }, 20_000)

  it('keeps the pinned methods pinned, exactly like the device token', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const refused = await rpc('credentials/describe', envelope('credentials/describe', {}), { cookie })
    expect(refused.status).toBe(403)
    expect(seenAt('/api/credentials/describe')).toHaveLength(0)
  })
})

describe('the ui-sync settings namespace under loopback-only', () => {
  it('serves describe to a paired device, cut down to ui-sync', async () => {
    const { token } = await pairDevice()
    const answer = await rpc('settings/describe', envelope('settings/describe', {}), { authorization: `Bearer ${token}` })
    expect(answer.status).toBe(200)
    const parsed = JSON.parse(answer.text) as { type: string, result: { ok: boolean, value: { writable: boolean, namespaces: { ns: string }[] } } }
    expect(parsed.type).toBe('server-response')
    expect(parsed.result.ok).toBe(true)
    expect(parsed.result.value.writable).toBe(true)
    expect(parsed.result.value.namespaces.map(entry => entry.ns)).toEqual(['ui-sync'])
    expect(answer.text).not.toContain('privilegedMethods')
    expect(answer.text).not.toContain('apiKey')
    // The harness saw a request the relay rebuilt: no arguments, nothing else.
    const sent = JSON.parse(seenAt('/api/settings/describe')[0]?.body ?? '{}') as Record<string, unknown>
    expect(sent.method).toBe('settings/describe')
    expect(sent.payload).toEqual({ args: {} })
  })

  it('serves the WebView session and a password session the same way', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const viaWebView = await rpc('settings/describe', envelope('settings/describe', {}), { cookie })
    expect(viaWebView.status).toBe(200)
    expect(viaWebView.text).not.toContain('"relay"')
    const signIn = auth.sessionGrant(Date.now())
    const viaSignIn = await rpc('settings/describe', envelope('settings/describe', {}), {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(signIn.cookie)}`,
    })
    expect(viaSignIn.status).toBe(200)
    expect(viaSignIn.text).toContain('"ui-sync"')
    expect(viaSignIn.text).not.toContain('"relay"')
  })

  it('writes the ui-sync namespace', async () => {
    const { token } = await pairDevice()
    const ops = [{ op: 'set', path: ['targets', 'dsh-pet|shell.overlay|pet'], value: 'desktop' }]
    const answer = await rpc('settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops }), { authorization: `Bearer ${token}` })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('"ui-sync"')
    const sent = JSON.parse(seenAt('/api/settings/mutate')[0]?.body ?? '{}') as { payload: unknown }
    expect(sent.payload).toEqual({ args: { ns: 'ui-sync', ops } })
  })

  it('refuses a write to any other namespace without reaching the harness', async () => {
    const { token } = await pairDevice()
    const bearer = { authorization: `Bearer ${token}` }
    for (const ns of ['relay', 'llm', 'ui-sync ', 'UI-SYNC', '']) {
      const answer = await rpc('settings/mutate', envelope('settings/mutate', { ns, ops: [] }), bearer)
      expect(answer.status).toBe(403)
    }
    const missing = await rpc('settings/mutate', envelope('settings/mutate', { ops: [] }), bearer)
    expect(missing.status).toBe(403)
    expect(seenAt('/api/settings/mutate')).toHaveLength(0)
  })

  it('judges the namespace the harness will read, because it forwards what it judged', async () => {
    const { token } = await pairDevice()
    const bearer = { authorization: `Bearer ${token}` }
    // JSON.parse keeps the last duplicate. Either order, the harness receives
    // only the namespace the relay checked.
    const sneaky = '{"type":"client-request","rpcId":"r1","method":"settings/mutate","payload":{"args":{"ns":"ui-sync","ns":"relay","ops":[]}}}'
    expect((await rpc('settings/mutate', sneaky, bearer)).status).toBe(403)
    const reversed = '{"type":"client-request","rpcId":"r2","method":"settings/mutate","payload":{"args":{"ns":"relay","ns":"ui-sync","ops":[]}}}'
    expect((await rpc('settings/mutate', reversed, bearer)).status).toBe(200)
    const forwarded = seenAt('/api/settings/mutate')
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0]?.body).not.toContain('relay')
    expect(forwarded[0]?.body).toBe(JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'settings/mutate', payload: { args: { ns: 'ui-sync', ops: [] } } }))
    expect(forwarded[0]?.headers['content-length']).toBe(String(Buffer.byteLength(forwarded[0]?.body ?? '')))
  })

  it('refuses arguments and envelopes it did not check', async () => {
    const { token } = await pairDevice()
    const bearer = { authorization: `Bearer ${token}` }
    const refused: readonly (readonly [string, string])[] = [
      ['settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops: [], extra: true })],
      ['settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops: 'not-a-list' })],
      ['settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops: [], expectedRevision: '3' })],
      // The path says describe, the envelope says mutate: the harness would
      // refuse the mismatch too, and the relay must not judge either one alone.
      ['settings/describe', envelope('settings/mutate', { ns: 'ui-sync', ops: [] })],
      ['settings/mutate', envelope('settings/describe', {})],
      ['settings/describe', envelope('settings/describe', { ns: 'relay' })],
      ['settings/describe', JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'settings/describe', payload: { args: {}, more: 1 } })],
      ['settings/describe', JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'settings/describe', payload: { args: [] } })],
      ['settings/describe', JSON.stringify({ type: 'something-else', rpcId: 'r', method: 'settings/describe', payload: { args: {} } })],
      ['settings/describe', JSON.stringify(['settings/describe'])],
    ]
    for (const [path, body] of refused) {
      expect((await rpc(path, body, bearer)).status, body).toBe(403)
    }
    expect(seenAt('/api/settings/mutate')).toHaveLength(0)
    expect(seenAt('/api/settings/describe')).toHaveLength(0)
  })

  it('refuses a body it cannot read as plain JSON', async () => {
    const { token } = await pairDevice()
    const headers = { ...REMOTE, authorization: `Bearer ${token}` }
    const body = envelope('settings/describe', {})
    expect((await call('/api/settings/describe', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body })).status).toBe(415)
    expect((await call('/api/settings/describe', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body,
    })).status).toBe(415)
    expect((await call('/api/settings/describe', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400)
    expect((await call('/api/settings/describe', { headers })).status).toBe(403)
    expect(seenAt('/api/settings/describe')).toHaveLength(0)
  })

  it('keeps every other pinned method on the machine', async () => {
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    for (const credential of [{ authorization: `Bearer ${token}` }, { cookie }]) {
      for (const method of [
        'settings/update',
        'settings/replace',
        'settings/openSettingsDocument',
        'credentials/describe',
        'credentials/set',
        'llm/discoverModels',
        'directoryPicker/pick',
        'agentPresets/read',
      ]) {
        const answer = await rpc(method, envelope(method, { ns: 'ui-sync', patch: {} }), credential)
        expect(answer.status, method).toBe(403)
      }
    }
    expect(received.filter(entry => entry.url.startsWith('/api/'))).toHaveLength(0)
  })

  it('never serves an address grant, a stranger, or the absent', () => {
    expect(reachesScopedSettings({ credential: 'device', deviceId: 'a', privileged: false })).toBe(true)
    expect(reachesScopedSettings({ credential: 'device-session', deviceId: 'a', privileged: false })).toBe(true)
    expect(reachesScopedSettings({ credential: 'session', privileged: false })).toBe(true)
    expect(reachesScopedSettings({ credential: 'address-grant', deviceId: 'a', privileged: false })).toBe(false)
    expect(reachesScopedSettings({ credential: 'none', privileged: false })).toBe(false)
  })

  it('refuses a describe answer it cannot filter, rather than passing it through', async () => {
    const { token } = await pairDevice()
    const bearer = { authorization: `Bearer ${token}` }
    for (const mode of ['not-json', 'multipart', 'no-namespaces', 'gzip'] as const) {
      describeMode = mode
      const answer = await rpc('settings/describe', envelope('settings/describe', {}), bearer)
      expect(answer.status, mode).toBe(502)
      expect(answer.text, mode).not.toContain('privilegedMethods')
    }
  })

  it('passes a describe refusal through, so the page can say why', async () => {
    const { token } = await pairDevice()
    describeMode = 'refusal'
    const answer = await rpc('settings/describe', envelope('settings/describe', {}), { authorization: `Bearer ${token}` })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('settings service is absent')
  })

  it('leaves allow-authenticated as it was: the whole plane, unfiltered', async () => {
    await restartRelay({ privilegedMethods: 'allow-authenticated' })
    const { token } = await pairDevice()
    const answer = await rpc('settings/describe', envelope('settings/describe', {}), { authorization: `Bearer ${token}` })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('"relay"')
    expect(answer.text).toContain('"llm"')
    const write = await rpc('settings/mutate', envelope('settings/mutate', { ns: 'relay', ops: [] }), { authorization: `Bearer ${token}` })
    expect(write.status).toBe(200)
  })
})

describe('recording a device as seen', () => {
  it('logs a failed write instead of leaving an unhandled rejection', async () => {
    const { token } = await pairDevice()
    const logged: string[] = []
    const listener = await startListener({
      runtime: { auth, config: configFor(), target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 }, log: (line) => { logged.push(line) } },
      bind: '127.0.0.1',
      port: 0,
      authorities: ['127.0.0.1', 'localhost'],
    })
    extraListeners.push(listener)
    // A reload or shutdown closes the store while a request is still being
    // answered; the last-seen write that request queued then fails.
    await store.close()
    const answer = await fetch(`http://127.0.0.1:${String(listener.port)}/api/settings/describe`, {
      method: 'POST',
      headers: { ...REMOTE, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: envelope('settings/describe', {}),
    })
    expect(answer.status).toBe(200)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    expect(logged.some(line => line.includes('could not record device') && line.includes('state store is closed'))).toBe(true)
  })
})

describe('the uiSyncSettings owner switch', () => {
  it('is on unless the operator turns it off', () => {
    expect(configFor().uiSyncSettings).toBe(true)
    expect(configFor({ uiSyncSettings: false }).uiSyncSettings).toBe(false)
  })

  it('on, serves the ui-sync calls to every signed-in credential', async () => {
    await restartRelay({ uiSyncSettings: true })
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const signIn = auth.sessionGrant(Date.now())
    const ops = [{ op: 'set', path: ['targets', 'dsh-pet|shell.overlay|pet'], value: 'both' }]
    for (const credential of [
      { authorization: `Bearer ${token}` },
      { cookie },
      { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signIn.cookie)}` },
    ]) {
      expect((await rpc('settings/describe', envelope('settings/describe', {}), credential)).status).toBe(200)
      expect((await rpc('settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops }), credential)).status).toBe(200)
    }
    expect(seenAt('/api/settings/describe')).toHaveLength(3)
    expect(seenAt('/api/settings/mutate')).toHaveLength(3)
  })

  it('off, pins both calls exactly like before 0.5.0, and the harness sees nothing', async () => {
    await restartRelay({ uiSyncSettings: false })
    const { token } = await pairDevice()
    const cookie = await deviceCookie(token)
    const signIn = auth.sessionGrant(Date.now())
    const ops = [{ op: 'set', path: ['targets', 'dsh-pet|shell.overlay|pet'], value: 'both' }]
    for (const credential of [
      { authorization: `Bearer ${token}` },
      { cookie },
      { cookie: `${SESSION_COOKIE}=${encodeURIComponent(signIn.cookie)}` },
    ]) {
      const described = await rpc('settings/describe', envelope('settings/describe', {}), credential)
      expect(described.status).toBe(403)
      // The pinned-method refusal itself, not one of the scoped path's own 403s.
      expect(JSON.parse(described.text)).toEqual({
        error: 'forbidden',
        message: 'this method is served only to the machine running the harness',
      })
      const mutate = await rpc('settings/mutate', envelope('settings/mutate', { ns: 'ui-sync', ops }), credential)
      expect(mutate.status).toBe(403)
      expect(mutate.text).not.toContain('ui-sync')
    }
    expect(received.filter(entry => entry.url.startsWith('/api/settings/'))).toHaveLength(0)
    // Unpinned calls and the WebView session are untouched by the switch.
    expect((await rpc('session/list', envelope('session/list', {}), { cookie })).status).toBe(200)
  })

  it('off, the operator at the machine still reaches settings', async () => {
    await restartRelay({ uiSyncSettings: false })
    const answer = await call('/api/settings/describe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: envelope('settings/describe', {}),
    })
    expect(answer.status).toBe(200)
    // Loopback is forwarded unfiltered, as it always was.
    expect(answer.text).toContain('"relay"')
  })

  it('off, changes nothing under allow-authenticated', async () => {
    await restartRelay({ privilegedMethods: 'allow-authenticated', uiSyncSettings: false })
    const { token } = await pairDevice()
    const answer = await rpc('settings/describe', envelope('settings/describe', {}), { authorization: `Bearer ${token}` })
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('"llm"')
  })
})

describe('the scoped request and answer, on their own', () => {
  it('rebuilds a mutate from the checked fields only', () => {
    const rebuilt = rebuildScopedRequest('settings/mutate', {
      type: 'client-request',
      rpcId: 'r',
      method: 'settings/mutate',
      payload: { args: { ns: 'ui-sync', ops: [{ op: 'unset', path: ['targets', 'a'] }], expectedRevision: 4 } },
    })
    expect(rebuilt).toEqual({
      ok: true,
      body: {
        type: 'client-request',
        rpcId: 'r',
        method: 'settings/mutate',
        payload: { args: { ns: 'ui-sync', ops: [{ op: 'unset', path: ['targets', 'a'] }], expectedRevision: 4 } },
      },
    })
  })

  it('drops every top-level field the harness envelope does not have', () => {
    const rebuilt = rebuildScopedRequest('settings/describe', {
      type: 'client-request',
      rpcId: 'r',
      method: 'settings/describe',
      payload: { args: {} },
      extra: { ns: 'relay' },
    })
    expect(rebuilt.ok && Object.keys(rebuilt.body)).toEqual(['type', 'rpcId', 'method', 'payload'])
  })

  it('filters by exact namespace and keeps the rest of the answer', () => {
    const filtered = filterDescribeAnswer({
      type: 'server-response',
      rpcId: 'r',
      result: { ok: true, value: { writable: false, hasDocument: true, namespaces: [{ ns: 'ui-sync' }, { ns: 'ui-sync-evil' }, { ns: 'relay' }, 'junk', null] } },
    })
    expect(filtered).toEqual({
      type: 'server-response',
      rpcId: 'r',
      result: { ok: true, value: { writable: false, hasDocument: true, namespaces: [{ ns: 'ui-sync' }] } },
    })
  })

  it('refuses an answer that is not a server response', () => {
    expect(filterDescribeAnswer(null)).toBeUndefined()
    expect(filterDescribeAnswer({ type: 'server-response', result: { ok: 'yes' } })).toBeUndefined()
    expect(filterDescribeAnswer({ type: 'other', result: { ok: true, value: { namespaces: [] } } })).toBeUndefined()
  })
})

describe('handoff codes', () => {
  const NOW = 1_700_000_000_000

  it('works once, within the minute', () => {
    const codes = new HandoffCodes()
    const { code, expiresAt } = codes.issue('device-a', '/', NOW)
    expect(expiresAt).toBe(NOW + HANDOFF_TTL_MS)
    expect(codes.consume(code, NOW + 1000)).toEqual({ deviceId: 'device-a', next: '/' })
    expect(codes.consume(code, NOW + 1000)).toBeUndefined()
  })

  it('is spent by a failed redemption too', () => {
    const codes = new HandoffCodes()
    const { code } = codes.issue('device-a', '/', NOW)
    expect(codes.consume(code, NOW + HANDOFF_TTL_MS)).toBeUndefined()
    expect(codes.size).toBe(0)
  })

  it('refuses a code from the future, after a clock step backwards', () => {
    const codes = new HandoffCodes()
    const { code } = codes.issue('device-a', '/', NOW)
    expect(codes.consume(code, NOW - 1)).toBeUndefined()
  })

  it('keeps a bounded number per device, dropping the oldest', () => {
    const codes = new HandoffCodes()
    const issued = Array.from({ length: 9 }, (_, index) => codes.issue('device-a', '/', NOW + index).code)
    const other = codes.issue('device-b', '/', NOW).code
    expect(codes.consume(issued[0] ?? '', NOW + 100)).toBeUndefined()
    expect(codes.consume(issued[8] ?? '', NOW + 100)?.deviceId).toBe('device-a')
    expect(codes.consume(other, NOW + 100)?.deviceId).toBe('device-b')
  })

  it('forgets one device\'s codes when it is unpaired', () => {
    const codes = new HandoffCodes()
    const mine = codes.issue('device-a', '/', NOW).code
    const theirs = codes.issue('device-b', '/', NOW).code
    codes.revokeDevice('device-a')
    expect(codes.consume(mine, NOW + 1)).toBeUndefined()
    expect(codes.consume(theirs, NOW + 1)?.deviceId).toBe('device-b')
  })
})

describe('the Relay link inside an embedding page', () => {
  it('hides when the page marks its html element, and still needs no script', () => {
    const injected = injectRelayLink('<!doctype html><html><body></body></html>')
    expect(injected).toContain('html[data-dsh-relay-badge="off"] #dsh-relay-link { display: none !important; }')
    expect(injected).not.toContain('<script')
  })
})
