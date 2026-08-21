/**
 * The transport half: forwarding, the `Host` rewrite the harness's own fence
 * depends on, WebSocket piping, and teardown.
 *
 * The client here is loopback, which the relay classifies as the operator by
 * definition — so this file proves the bytes move correctly and leaves
 * credential gating to `auth.spec.ts` and `fence.spec.ts`, which can drive a
 * remote identity directly.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator } from '../src/auth/index.ts'
import { Config, type Config as RelayConfig } from '../src/config.ts'
import { startListener, type RelayListener, type RelayRuntime } from '../src/server.ts'
import { RelayStore } from '../src/state.ts'

/** The RFC 6455 handshake GUID, so the fake upstream can answer a real upgrade. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** What the fake upstream recorded about the last request it saw. */
interface Seen {
  url?: string
  headers?: Record<string, string | string[] | undefined>
}

let upstream: Server
let upstreamPort: number
const upstreamSockets = new Set<Duplex>()
let relay: RelayListener
let store: RelayStore
let auth: Authenticator
let dir: string
const seen: Seen = {}

/** Stand in for the harness web server: echo what arrived, and speak one upgrade. */
function startUpstream(): Promise<{ server: Server, port: number }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.url = req.url
    seen.headers = req.headers
    if (req.url === '/api/slow') {
      // Held open so the teardown case has a live connection to force closed.
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin ?? null }))
  })
  // An upgraded socket is excluded from closeAllConnections here exactly as it
  // is in the relay, so the fixture tracks them or teardown hangs.
  server.on('connection', (socket) => { upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket)) })
  server.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    seen.url = req.url
    seen.headers = req.headers
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(`${String(key)}${WS_GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    if (head.length > 0) socket.write(head)
    // A byte the relay must carry back down the pipe.
    socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address !== null ? address.port : 0 })
    })
  })
}

/** Send one raw request over a socket and read the whole answer. */
function rawRequest(port: number, lines: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let received = ''
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')) })
    socket.on('data', (chunk) => { received += chunk.toString('binary') })
    socket.on('error', reject)
    socket.on('close', () => { resolve(received) })
  })
}

/** Open a raw WebSocket handshake and resolve once bytes come back. */
function rawUpgrade(port: number, path: string, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'))
    })
    let received = ''
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')) })
    socket.on('data', (chunk) => {
      received += chunk.toString('binary')
      if (received.includes('hi') || received.includes('403')) {
        socket.destroy()
        resolve(received)
      }
    })
    socket.on('error', reject)
    socket.on('close', () => { resolve(received) })
  })
}

async function startRelay(overrides: Partial<RelayConfig> = {}): Promise<void> {
  const config = Config({ stateDir: dir, port: 0, tls: 'off', mdns: false, ...overrides }) as RelayConfig
  auth = new Authenticator(store, config)
  const runtime: RelayRuntime = {
    auth,
    config,
    target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 },
    log: () => undefined,
  }
  relay = await startListener({
    runtime,
    bind: '127.0.0.1',
    port: 0,
    authorities: ['127.0.0.1', 'localhost', 'relay.test'],
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-relay-proxy-'))
  store = await RelayStore.open(dir)
  const started = await startUpstream()
  upstream = started.server
  upstreamPort = started.port
  await startRelay()
})

afterEach(async () => {
  await relay.close()
  auth.dispose()
  await store.close()
  for (const socket of upstreamSockets) socket.destroy()
  upstreamSockets.clear()
  await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => { resolve() }) })
  await rm(dir, { recursive: true, force: true })
})

describe('http forwarding', () => {
  it('rewrites Host to the loopback harness, which is what unlocks its own fence', async () => {
    const answer = await rawRequest(relay.port, [
      'GET /api/echo HTTP/1.1',
      'Host: relay.test',
      'Connection: close',
    ])
    expect(answer).toContain('200 OK')
    expect(seen.headers?.host).toBe(`127.0.0.1:${String(upstreamPort)}`)
  })

  it('rewrites an attached Origin to the same authority, or the upstream fence would refuse it', async () => {
    await rawRequest(relay.port, [
      'GET /api/echo HTTP/1.1',
      'Host: relay.test',
      'Origin: http://relay.test',
      'Connection: close',
    ])
    expect(seen.headers?.origin).toBe(`http://127.0.0.1:${String(upstreamPort)}`)
  })

  it('does not forward the relay-only credentials', async () => {
    await rawRequest(relay.port, [
      'GET /api/echo HTTP/1.1',
      'Host: relay.test',
      'Authorization: Bearer secret',
      'Cookie: dsh_relay_session=secret',
      'Connection: close',
    ])
    expect(seen.headers?.authorization).toBeUndefined()
    expect(seen.headers?.cookie).toBeUndefined()
  })

  it('refuses an untrusted Host before anything reaches the harness', async () => {
    seen.url = undefined
    const answer = await rawRequest(relay.port, [
      'GET /api/echo HTTP/1.1',
      'Host: evil.example',
      'Connection: close',
    ])
    expect(answer).toContain('403')
    expect(seen.url).toBeUndefined()
  })

  it('refuses a cross-site marker even from a trusted host', async () => {
    const answer = await rawRequest(relay.port, [
      'GET /api/echo HTTP/1.1',
      'Host: relay.test',
      'Sec-Fetch-Site: cross-site',
      'Connection: close',
    ])
    expect(answer).toContain('403')
  })

  it('refuses a write to a path it does not proxy, so an unknown RPC channel stays local', async () => {
    seen.url = undefined
    const answer = await rawRequest(relay.port, [
      'POST /some-other-plugin/channel HTTP/1.1',
      'Host: relay.test',
      'Content-Length: 0',
      'Connection: close',
    ])
    expect(answer).toContain('404')
    expect(seen.url).toBeUndefined()
  })

  it('still serves reads on any path, because that is the single-page application', async () => {
    const answer = await rawRequest(relay.port, [
      'GET /workspace/some/deep/route HTTP/1.1',
      'Host: relay.test',
      'Connection: close',
    ])
    expect(answer).toContain('200 OK')
    expect(seen.url).toBe('/workspace/some/deep/route')
  })

  it('serves its own health endpoint without touching the harness', async () => {
    seen.url = undefined
    const answer = await rawRequest(relay.port, [
      'GET /relay/health HTTP/1.1',
      'Host: relay.test',
      'Connection: close',
    ])
    expect(answer).toContain('"service":"dsh-relay"')
    expect(seen.url).toBeUndefined()
  })
})

describe('websocket forwarding', () => {
  it('replays the upstream 101 and pipes bytes both ways', async () => {
    const answer = await rawUpgrade(relay.port, '/api/events.mux', 'relay.test')
    expect(answer).toContain('101 Switching Protocols')
    expect(answer.toLowerCase()).toContain('sec-websocket-accept')
    // The frame the fake upstream pushed came back down the pipe unchanged.
    expect(answer).toContain('hi')
    expect(seen.url).toBe('/api/events.mux')
    expect(seen.headers?.host).toBe(`127.0.0.1:${String(upstreamPort)}`)
  })

  it('refuses an upgrade from an untrusted host without opening one upstream', async () => {
    seen.url = undefined
    const answer = await rawUpgrade(relay.port, '/api/events.mux', 'evil.example')
    expect(answer).toContain('403')
    expect(seen.url).toBeUndefined()
  })
})

describe('teardown', () => {
  it('closes the port even with a request held open, so a reload can re-listen', async () => {
    const held = connect(relay.port, '127.0.0.1', () => {
      held.write('GET /api/slow HTTP/1.1\r\nHost: relay.test\r\n\r\n')
    })
    held.on('error', () => undefined)
    await new Promise(resolve => setTimeout(resolve, 100))
    const port = relay.port
    await relay.close()
    held.destroy()

    // The port is free: a fresh listener binds it without EADDRINUSE.
    const probe = createServer()
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(port, '127.0.0.1', () => { resolve() })
    })
    await new Promise<void>((resolve) => { probe.close(() => { resolve() }) })
    // afterEach closes the relay again; closing twice is harmless.
    relay = { port, close: async () => undefined }
  })
})
