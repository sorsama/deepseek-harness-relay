/**
 * The relay's listeners and the order every request passes through.
 *
 * One request, one sequence, and the order is the security model:
 *
 * 1. rate limit, so an attacker cannot make the rest of this cheap to probe;
 * 2. the trust fence, which decides whether this request is even addressed to
 *    us — before any credential is read, so an untrusted authority never
 *    reaches the comparison;
 * 3. the relay's own routes, which are how a client obtains a credential;
 * 4. write-method scoping, which keeps a POST off any upstream path this relay
 *    does not know about;
 * 5. authentication;
 * 6. the pinned-method gate, which re-imposes upstream's loopback-only set
 *    that step 7 is about to lift;
 * 7. the proxy, which rewrites `Host` to loopback and forwards.
 *
 * Reordering any of these is a vulnerability, not a refactor.
 * @module dsh-relay/server
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Authenticator, CredentialClass, Identity } from './auth/index.ts'
import type { Config } from './config.ts'
import { checkFence, isLoopbackHostname } from './fence.ts'
import { isPinnedMethod } from './privileged.ts'
import { forward, type UpstreamTarget } from './proxy/http.ts'
import { normalizeAddress } from './proxy/rewrite.ts'
import { forwardUpgrade, rejectUpgrade, SocketLedger } from './proxy/ws.ts'
import { handleRelayRoute, isAuthenticated, RELAY_PREFIX } from './routes.ts'
import type { TlsMaterial } from './tls.ts'
import { sendHtml, sendJson, sendRedirect } from './wire.ts'
import { messagePage } from './pages/views.ts'

/** Everything a listener needs to serve one request. */
export interface RelayRuntime {
  readonly auth: Authenticator
  readonly config: Config
  readonly target: UpstreamTarget
  readonly fingerprint?: string | undefined
  /**
   * Port of the plain-HTTP compatibility listener, when one is running.
   *
   * The port rather than a whole origin: a machine commonly has several LAN
   * addresses (a virtual-machine adapter alongside real Wi-Fi), and picking
   * one at startup names an address the client may have no route to. The
   * origin is built per request from the host the client actually reached,
   * which is reachable from that client by construction.
   */
  plainPort?: number | undefined
  /** Report a refusal; the plugin routes this to the Cordis logger. */
  readonly log: (message: string) => void
}

/** How one listener treats the requests that reach it. */
interface ListenerPolicy {
  /** Whether this listener terminates TLS. */
  readonly secure: boolean
  /** Credential classes this listener accepts. */
  readonly accepts: ReadonlySet<CredentialClass>
  /** Whether the relay's sign-in and pairing routes are served here. */
  readonly servesRelayRoutes: boolean
}

/** The primary listener: every credential class, every relay route. */
const PRIMARY_POLICY = (secure: boolean): ListenerPolicy => ({
  secure,
  accepts: new Set<CredentialClass>(['loopback', 'session', 'device', 'address-grant']),
  servesRelayRoutes: true,
})

/**
 * The plain-HTTP compatibility listener.
 *
 * It exists for one client — DSH Mobile 0.5.0, which hardcodes `http://` and
 * cannot reach a TLS listener at all. It therefore accepts only the credential
 * classes that client can actually carry, refuses password sessions (a sign-in
 * cookie must never cross an unencrypted hop), and serves no relay routes
 * except the liveness probe: pairing happens over the primary listener or on
 * loopback, where the minted token is not readable off the wire.
 */
const COMPAT_POLICY: ListenerPolicy = {
  secure: false,
  accepts: new Set<CredentialClass>(['loopback', 'device', 'address-grant']),
  servesRelayRoutes: false,
}

/** Path prefixes a write method may address without being named in config. */
const WRITE_PREFIXES = ['/api/', '/api?']

/** Paths a write method may address exactly. */
const WRITE_PATHS = new Set(['/api'])

/**
 * Whether a write request may be proxied at all.
 *
 * Reads pass freely — that is the single-page application, its bundles, and
 * its assets. Writes are scoped, because the harness's Connection carrier lets
 * any plugin register an RPC channel of its own under a path this relay has
 * never heard of, and several of them are declared loopback-only. Rewriting
 * `Host` would promote every such channel to network-reachable; refusing an
 * unrecognized write path keeps that promotion to the one channel this relay
 * actually reasons about.
 * @param pathname - the request pathname.
 * @param extra - operator-declared additional prefixes.
 * @returns true when the write may proceed.
 */
function writeAllowed(pathname: string, extra: readonly string[]): boolean {
  if (WRITE_PATHS.has(pathname)) return true
  if (WRITE_PREFIXES.some(prefix => pathname.startsWith(prefix))) return true
  return extra.some(prefix => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/** Whether a browser asked for a document, and so should be redirected rather than refused. */
function wantsDocument(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? ''
  return accept.includes('text/html')
}

/** The origin a client used to reach this listener. */
function originOf(req: IncomingMessage, secure: boolean): string {
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
  return `${secure ? 'https' : 'http'}://${host}`
}

/**
 * The plain listener's origin, as this client would reach it.
 * @param req - the inbound request, read for the host it addressed.
 * @param plainPort - the compatibility listener's port, when one is running.
 * @returns the origin, or undefined when no plain listener exists.
 */
function plainOriginOf(req: IncomingMessage, plainPort: number | undefined): string | undefined {
  if (plainPort === undefined) return undefined
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
  const hostname = host.replace(/:\d+$/, '')
  return `http://${hostname}:${String(plainPort)}`
}

/**
 * Serve one request, in the order the module comment describes.
 * @param req - the inbound request.
 * @param res - the response, owned entirely by this call.
 * @param runtime - the relay's live state.
 * @param policy - what this listener accepts.
 * @param authorities - the authorities this relay answers to.
 * @returns resolution once the response is finished.
 */
async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: RelayRuntime,
  policy: ListenerPolicy,
  authorities: readonly string[],
): Promise<void> {
  const now = Date.now()
  const address = normalizeAddress(req.socket.remoteAddress)
  const local = isLoopbackHostname(address === '' ? 'x' : address)

  if (!local && runtime.auth.exceedsRate(address, now)) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' })
    res.end('too many requests')
    return
  }

  const rejection = checkFence({ headers: req.headers, method: req.method }, authorities)
  if (rejection !== undefined) {
    runtime.log(`refused ${req.method ?? 'GET'} ${req.url ?? '/'} from ${address}: ${rejection}`)
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return
  }

  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://relay.invalid')
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bad request')
    return
  }

  const identity = classify(runtime.auth, req, address, local, policy, now)

  if (url.pathname === RELAY_PREFIX || url.pathname.startsWith(`${RELAY_PREFIX}/`)) {
    if (!policy.servesRelayRoutes && url.pathname !== '/relay/health') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    await handleRelayRoute(req, res, url, {
      auth: runtime.auth,
      config: runtime.config,
      identity,
      address,
      origin: originOf(req, policy.secure),
      plainOrigin: plainOriginOf(req, runtime.plainPort),
      fingerprint: runtime.fingerprint,
      secure: policy.secure,
      now,
    })
    return
  }

  const method = req.method ?? 'GET'
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if (!isRead && !writeAllowed(url.pathname, runtime.config.extraProxyPaths)) {
    runtime.log(`refused ${method} ${url.pathname}: not a proxied write path`)
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }

  if (!isAuthenticated(identity)) {
    if (wantsDocument(req) && policy.servesRelayRoutes) {
      sendRedirect(res, `/relay/login?next=${encodeURIComponent(url.pathname + url.search)}`)
      return
    }
    // 403 rather than 401: the mobile client reads 403 as "reached the harness,
    // it refused this address" and anything else as "not a harness".
    if ((req.headers.accept ?? '').includes('application/json') || url.pathname.startsWith('/api')) {
      sendJson(res, 403, { error: 'forbidden', message: 'pair this device with the relay first' })
      return
    }
    sendHtml(res, 403, messagePage({
      title: 'Not signed in',
      message: 'Pair this device with the relay, or sign in, before reaching the harness.',
      kind: 'error',
    }))
    return
  }

  if (isPinnedMethod(url.pathname, identity.privileged)) {
    runtime.log(`refused ${url.pathname} for ${identity.credential}: privileged method`)
    sendJson(res, 403, {
      error: 'forbidden',
      message: 'this method is served only to the machine running the harness',
    })
    return
  }

  if (identity.deviceId !== undefined) {
    void runtime.auth.touch(identity.deviceId, address, now)
  }

  await forward(req, res, runtime.target)
}

/**
 * Classify a request under one listener's policy.
 * @param auth - the authenticator.
 * @param req - the inbound request.
 * @param address - normalized source address.
 * @param local - whether the peer is loopback.
 * @param policy - what this listener accepts.
 * @param now - current epoch millis.
 * @returns the identity, downgraded to `none` when the listener refuses that class.
 */
function classify(
  auth: Authenticator,
  req: IncomingMessage,
  address: string,
  local: boolean,
  policy: ListenerPolicy,
  now: number,
): Identity {
  const identity = auth.identify({ headers: req.headers, address, local }, now)
  if (!policy.accepts.has(identity.credential)) return { credential: 'none', privileged: false }
  return identity
}

/**
 * Handle one upgrade request.
 *
 * The mobile client opens both downlinks concurrently and gives them 3000 ms
 * together before it abandons the connection generation, so this path does no
 * I/O of its own: the fence reads headers, and the credential check is one
 * HMAC against in-memory state.
 * @param req - the upgrade request.
 * @param socket - the client socket.
 * @param head - bytes already read past the handshake.
 * @param runtime - the relay's live state.
 * @param policy - what this listener accepts.
 * @param authorities - the authorities this relay answers to.
 * @param ledger - registry the established sockets join.
 */
function serveUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtime: RelayRuntime,
  policy: ListenerPolicy,
  authorities: readonly string[],
  ledger: SocketLedger,
): void {
  const now = Date.now()
  const address = normalizeAddress(req.socket.remoteAddress)
  const local = isLoopbackHostname(address === '' ? 'x' : address)

  if (checkFence({ headers: req.headers, method: req.method }, authorities) !== undefined) {
    rejectUpgrade(socket, 403, 'Forbidden')
    return
  }
  const identity = classify(runtime.auth, req, address, local, policy, now)
  if (!isAuthenticated(identity)) {
    rejectUpgrade(socket, 403, 'Forbidden')
    return
  }
  if (identity.deviceId !== undefined) {
    void runtime.auth.touch(identity.deviceId, address, now)
  }
  forwardUpgrade(req, socket, head, runtime.target, ledger)
}

/** A running listener and the handle that shuts it down. */
export interface RelayListener {
  /** The port actually bound, resolved when the configured port was zero. */
  readonly port: number
  /** Close the listener and force every connection, upgraded ones included. */
  close: () => Promise<void>
}

/**
 * Start one listener.
 * @param options.runtime - the relay's live state.
 * @param options.bind - listen address.
 * @param options.port - listen port; zero requests an OS-assigned port.
 * @param options.tls - certificate material, or undefined for plaintext.
 * @param options.compat - run under the compatibility policy rather than the primary one.
 * @param options.authorities - the authorities this relay answers to.
 * @returns the running listener.
 */
export async function startListener(options: {
  readonly runtime: RelayRuntime
  readonly bind: string
  readonly port: number
  readonly tls?: TlsMaterial | undefined
  readonly compat?: boolean
  readonly authorities: readonly string[]
}): Promise<RelayListener> {
  const policy = options.compat === true ? COMPAT_POLICY : PRIMARY_POLICY(options.tls !== undefined)
  const ledger = new SocketLedger()

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void serve(req, res, options.runtime, policy, options.authorities).catch((error: unknown) => {
      options.runtime.log(`request failed: ${String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('internal error')
      } else {
        res.destroy()
      }
    })
  }

  const server: Server = options.tls === undefined
    ? createHttpServer(handler)
    : createHttpsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2' }, handler)

  server.on('upgrade', (req, socket, head) => {
    serveUpgrade(req, socket, head, options.runtime, policy, options.authorities, ledger)
  })
  // A slow or absent handshake must not hold a socket open indefinitely, but
  // an established downlink is idle by design — `forwardUpgrade` clears the
  // timeout on the sockets it adopts.
  server.setTimeout(120_000)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.bind, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const bound = server.address()
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port

  return {
    port,
    close: async () => {
      // Upgraded sockets are excluded from closeAllConnections, and a live
      // downlink never ends on its own, so teardown would hang without the
      // ledger. Awaiting the close is what makes a config reload able to
      // re-listen on the same port instead of failing with EADDRINUSE.
      ledger.destroyAll()
      server.closeAllConnections()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
