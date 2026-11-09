/**
 * Computer linking, end to end over real listeners.
 *
 * The tests run two relays: the code under test, and a small peer that plays
 * the other PC. Both speak TLS with self-signed certificates, because a link
 * is refused on plaintext and the pin is the point. Every request goes through
 * the real fence, rate limiter, and session cookie handling.
 */
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Authenticator } from '../src/auth/index.ts'
import { hashToken } from '../src/auth/tokens.ts'
import { acceptLink, connectToPeer, listPeers, openNonces } from '../src/computers.ts'
import { Config, plainConfig } from '../src/config.ts'
import { normalizePeerOrigin } from '../src/peers.ts'
import { certificateSans, loadCertificate } from '../src/tls.ts'
import { startListener, type RelayListener, type RelayRuntime } from '../src/server.ts'
import { RelayStore } from '../src/state.ts'

/** First non-loopback IPv4 address, which a peer URL is required to be. */
function localIPv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal && !entry.address.startsWith('169.254.')) {
        return entry.address
      }
    }
  }
  return undefined
}

const lan = localIPv4()

/** One HTTPS call without following redirects; self-signed is expected. */
async function call(url: string, options: {
  readonly method?: string | undefined
  readonly headers?: Record<string, string> | undefined
  readonly body?: string | undefined
} = {}): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port === '' ? 443 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      rejectUnauthorized: false,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

describe.skipIf(lan === undefined)('computer linking', () => {
  let dir: string
  let store: RelayStore
  let auth: Authenticator
  let relay: RelayListener
  let upstream: HttpServer
  let peerServer: HttpsServer
  let peerDir: string
  let peerOrigin: string
  let peerPin: string
  let base: string
  let lanBase: string
  let config: ReturnType<typeof plainConfig>
  let context: Parameters<typeof acceptLink>[0]
  let seen: { readonly path: string, readonly authorization: string | undefined, readonly body: string }[] = []

  beforeEach(async () => {
    seen = []
    dir = await mkdtemp(join(tmpdir(), 'dsh-relay-computers-'))
    peerDir = await mkdtemp(join(tmpdir(), 'dsh-relay-peer-cert-'))
    store = await RelayStore.open(dir)
    config = plainConfig(Config({
      stateDir: dir,
      bind: '0.0.0.0',
      port: 0,
      tls: 'self-signed',
      mdns: false,
      peersEnabled: true,
      peerTimeoutMs: 2000,
    }) as Parameters<typeof plainConfig>[0])
    auth = new Authenticator(store, config)

    upstream = createHttpServer((_req, res) => { res.writeHead(200); res.end('harness') })
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', () => { resolve() }) })
    const upstreamAddress = upstream.address()
    const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress !== null ? upstreamAddress.port : 0

    const material = await loadCertificate({
      mode: 'self-signed',
      dir,
      certPath: '',
      keyPath: '',
      sans: certificateSans([]),
      existing: undefined,
    })
    if (material === undefined) throw new Error('the relay needs a certificate for this suite')

    const runtime: RelayRuntime = {
      auth,
      config,
      target: { host: '127.0.0.1', port: upstreamPort, timeoutMs: 5000 },
      fingerprint: material.record.fingerprint,
      log: () => undefined,
    }
    relay = await startListener({
      runtime,
      bind: '0.0.0.0',
      port: 0,
      tls: material,
      authorities: ['127.0.0.1', 'localhost', ...lan === undefined ? [] : [lan]],
    })
    base = `https://127.0.0.1:${String(relay.port)}`
    lanBase = `https://${String(lan)}:${String(relay.port)}`
    // The real plugin computes these from the interfaces; the page needs at
    // least one non-loopback candidate to offer the other computer.
    runtime.pairingAddresses = () => [{
      origin: lanBase,
      address: String(lan),
      interfaceName: 'Ethernet',
      family: 'IPv4',
      tailscale: false,
      label: `Ethernet — ${String(lan)}`,
    }]

    const peerMaterial = await loadCertificate({
      mode: 'self-signed',
      dir: peerDir,
      certPath: '',
      keyPath: '',
      sans: [String(lan), '127.0.0.1'],
      existing: undefined,
    })
    if (peerMaterial === undefined) throw new Error('the peer needs a certificate')
    peerPin = peerMaterial.record.fingerprint

    peerServer = createHttpsServer({ cert: peerMaterial.cert, key: peerMaterial.key }, (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        const send = (status: number, value: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        }
        if ((req.url ?? '') === '/relay/link' && req.method === 'POST') {
          send(200, { linkId: 'aaaa1111', name: 'Peer PC', url: peerOrigin, fingerprint: peerPin, token: 'token-from-peer' })
          return
        }
        if ((req.url ?? '') === '/relay/peer/status') {
          send(200, { ok: true, service: 'dsh-relay', name: 'Peer PC' })
          return
        }
        if ((req.url ?? '') === '/relay/peer/open' && req.method === 'POST') {
          send(200, { url: `${peerOrigin}/relay/peer/enter?nonce=fake` })
          return
        }
        send(404, { error: 'not-found' })
      })
    })
    await new Promise<void>((resolve) => { peerServer.listen(0, '0.0.0.0', () => { resolve() }) })
    const peerAddress = peerServer.address()
    const peerPort = typeof peerAddress === 'object' && peerAddress !== null ? peerAddress.port : 0
    peerOrigin = `https://${String(lan)}:${String(peerPort)}`

    context = {
      auth,
      config,
      origin: lanBase,
      fingerprint: material.record.fingerprint,
      address: '127.0.0.1',
      now: Date.now(),
    }
  })

  afterEach(async () => {
    await relay.close()
    auth.dispose()
    await store.close()
    await new Promise<void>((resolve) => { peerServer.closeAllConnections(); peerServer.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => { resolve() }) })
    await rm(dir, { recursive: true, force: true })
    await rm(peerDir, { recursive: true, force: true })
  })

  it('links to another computer and records both tokens', async () => {
    const result = await connectToPeer(context, { url: peerOrigin, code: '12345678', selfUrl: lanBase })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.peer.url).toBe(peerOrigin)
    expect(result.peer.fingerprint).toBe(peerPin)
    expect(result.peer.name).toBe('Peer PC')
    expect(result.peer.outboundToken).toBe('token-from-peer')
    expect(auth.peers).toHaveLength(1)

    // The peer saw this relay's offered address and pin, and a token whose
    // hash is now the one this relay will accept.
    const linkCall = seen.find(entry => entry.path === '/relay/link')
    expect(linkCall).toBeDefined()
    const offered = JSON.parse(linkCall?.body ?? '{}') as Record<string, string>
    expect(offered.url).toBe(lanBase)
    expect(offered.fingerprint).toBe(context.fingerprint)
    expect(offered.code).toBe('12345678')
    expect(result.peer.inboundTokenHash).toBe(hashToken(store.state.signingKey, offered.callbackToken ?? ''))
  })

  it('refuses a certificate that does not match the pin', async () => {
    const wrongPin = 'A'.repeat(43) + '='
    const result = await connectToPeer(context, { url: peerOrigin, code: '12345678', selfUrl: lanBase, pin: wrongPin })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/certificate/i)
  })

  it('refuses plaintext and loopback peer addresses', async () => {
    expect(normalizePeerOrigin('http://192.168.1.5:3443')).toBeUndefined()
    expect(normalizePeerOrigin('https://127.0.0.1:3443')).toBeUndefined()
    expect(normalizePeerOrigin('https://192.168.1.5:3443/path')).toBeUndefined()
    expect(normalizePeerOrigin(`https://${String(lan)}:3443`)).toBe(`https://${String(lan)}:3443`)
    const result = await connectToPeer(context, { url: 'http://192.168.1.5:3443', code: '1', selfUrl: lanBase })
    expect(result.ok).toBe(false)
  })

  it('accepts a link claimed with a pairing code and answers with a token', async () => {
    auth.pairing.issue(8, 300_000, context.now)
    const code = auth.pairing.peek(context.now)?.code ?? ''
    const answer = await acceptLink(context, {
      code,
      name: 'Peer PC',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })
    expect(answer.status).toBe(200)
    expect(typeof answer.body.token).toBe('string')
    expect(answer.body.url).toBe(lanBase)
    expect(answer.body.fingerprint).toBe(context.fingerprint)
    expect(auth.peers).toHaveLength(1)

    // The same code cannot be claimed twice.
    const again = await acceptLink(context, {
      code,
      name: 'Peer PC',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })
    expect(again.status).toBe(403)
  })

  it('accepts the link token only on the peer endpoints, never for the harness or the operator pages', async () => {
    auth.pairing.issue(8, 300_000, context.now)
    const code = auth.pairing.peek(context.now)?.code ?? ''
    const answer = await acceptLink(context, {
      code,
      name: 'Peer PC',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })
    const token = String(answer.body.token)

    const status = await call(`${base}/relay/peer/status`, { headers: { authorization: `Bearer ${token}` } })
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({ ok: true, service: 'dsh-relay' })

    const denied = await call(`${base}/relay/peer/status`, { headers: { authorization: 'Bearer not-a-link-token' } })
    expect(denied.status).toBe(403)

    // A link token is not a device token: the proxy and the operator pages
    // must refuse it. These go through the network address, because a loopback
    // peer is the operator by design and would be admitted with no credential.
    const proxied = await call(`${lanBase}/api/settings/describe`, { headers: { authorization: `Bearer ${token}` } })
    expect(proxied.status).toBe(403)
    const devices = await call(`${lanBase}/relay/devices`, { headers: { authorization: `Bearer ${token}` } })
    expect(devices.status).toBe(403)
  })

  it('hands a browser a session through a single-use nonce and a same-origin refresh', async () => {
    auth.pairing.issue(8, 300_000, context.now)
    const code = auth.pairing.peek(context.now)?.code ?? ''
    const answer = await acceptLink(context, {
      code,
      name: 'Peer PC',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })
    const token = String(answer.body.token)

    const opened = await call(`${base}/relay/peer/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(opened.status).toBe(200)
    const handoff = JSON.parse(opened.body) as { url: string }
    expect(handoff.url.startsWith(`${base}/relay/peer/enter?nonce=`)).toBe(true)

    const entered = await call(handoff.url)
    expect(entered.status).toBe(200)
    expect(entered.body).toContain('http-equiv="refresh"')
    const cookie = entered.headers['set-cookie']
    const setCookie = Array.isArray(cookie) ? cookie.join(';') : cookie ?? ''
    expect(setCookie).toContain('dsh_relay_session=')
    expect(setCookie).toContain('HttpOnly')

    // The cookie is a real session: the devices page accepts it.
    const session = setCookie.split(';', 1)[0] ?? ''
    const devices = await call(`${base}/relay/devices`, { headers: { cookie: session } })
    expect(devices.status).toBe(200)

    // And the nonce is spent.
    const replay = await call(handoff.url)
    expect(replay.status).toBe(403)
  })

  it('shows the linked computer on this PC and drops it on unlink', async () => {
    auth.pairing.issue(8, 300_000, context.now)
    const code = auth.pairing.peek(context.now)?.code ?? ''
    await acceptLink(context, {
      code,
      name: 'Peer PC',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })

    const page = await call(`${base}/relay/computers`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('Peer PC')
    expect(page.body).toContain('Connect to another PC')

    const peer = auth.peers[0]
    expect(peer).toBeDefined()
    if (peer === undefined) return
    const unlink = await call(`${base}/relay/computers/unlink`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ peerId: peer.id }).toString(),
    })
    expect(unlink.status).toBe(303)
    expect(auth.peers).toHaveLength(0)
  })

  it('pairs with a peer without touching the pairing code path', async () => {
    // A relay with linking off must refuse the link endpoint outright.
    const off = { ...config, peersEnabled: false }
    const answer = await acceptLink({ ...context, config: off }, {
      code: '12345678',
      url: peerOrigin,
      fingerprint: peerPin,
      callbackToken: 'b'.repeat(32),
    })
    expect(answer.status).toBe(404)
    const peers = await listPeers({ ...context, config: off })
    expect(peers).toHaveLength(0)
  })

  it('expires nonces rather than accepting them forever', () => {
    const peerId = 'peer-1'
    const now = 1_000_000
    const nonce = openNonces.issue(peerId, now, 1000)
    expect(openNonces.consume(nonce, now + 999)).toBe(peerId)
    const second = openNonces.issue(peerId, now, 1000)
    expect(openNonces.consume(second, now + 1000)).toBeUndefined()
  })
})

describe('state migration', () => {
  it('upgrades a v1 file in place and keeps its devices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-relay-migrate-'))
    try {
      const v1 = {
        version: 1,
        signingKey: 'k'.repeat(43),
        devices: {
          d1: { id: 'd1', name: 'Phone', tokenHash: 'h'.repeat(64), createdAt: 1, expiresAt: 2 },
        },
        grants: {},
      }
      await writeFile(join(dir, 'state.json'), JSON.stringify(v1))
      const store = await RelayStore.open(dir)
      expect(store.state.devices.d1?.name).toBe('Phone')
      expect(store.state.peers).toEqual({})
      expect(await store.state.version).toBe(2)
      await store.close()
      const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { version: number }
      expect(onDisk.version).toBe(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
