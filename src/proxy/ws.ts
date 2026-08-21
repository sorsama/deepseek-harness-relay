/**
 * WebSocket upgrade forwarding.
 *
 * The relay never terminates the WebSocket protocol: it forwards the
 * handshake, replays the upstream's 101 verbatim, and then pipes bytes. That
 * keeps `Sec-WebSocket-Accept` correct without recomputing it, leaves
 * extension negotiation end-to-end, and means the harness's own close frames
 * (it closes with 1008 on the first client-sent frame, both downlinks being
 * server-to-client only) reach the client unchanged.
 *
 * Every upgraded socket is registered with the caller's ledger. Node's
 * `server.closeAllConnections()` does not include upgraded sockets, so without
 * the ledger a plugin unload would hang on a live downlink — the harness's own
 * web server works around the same gap.
 * @module dsh-relay/proxy/ws
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { loopbackAuthority, type UpstreamTarget } from './http.ts'
import { upstreamHeaders } from './rewrite.ts'

/** Tracks live upgraded sockets so teardown can force them closed. */
export class SocketLedger {
  readonly #sockets = new Set<Duplex>()

  /**
   * Register a socket and forget it again when it closes.
   * @param socket - the upgraded socket.
   */
  track(socket: Duplex): void {
    this.#sockets.add(socket)
    socket.once('close', () => { this.#sockets.delete(socket) })
  }

  /** Destroy every tracked socket. */
  destroyAll(): void {
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
  }

  /** How many sockets are live. */
  get size(): number {
    return this.#sockets.size
  }
}

/**
 * Refuse an upgrade before it is established.
 * @param socket - the client socket.
 * @param status - HTTP status line code.
 * @param reason - reason phrase, echoed into the body.
 */
export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\n\r\n`)
}

/**
 * Prepare a socket for interactive traffic.
 *
 * The default server socket timeout would silently kill an idle downlink, and
 * Nagle batching adds latency to the small frames a streaming chat turn is
 * made of.
 * @param socket - the socket to configure.
 */
function tune(socket: Duplex): void {
  const tunable = socket as Duplex & {
    setNoDelay?: (value: boolean) => void
    setTimeout?: (value: number) => void
    setKeepAlive?: (enable: boolean, delay: number) => void
  }
  tunable.setNoDelay?.(true)
  tunable.setTimeout?.(0)
  tunable.setKeepAlive?.(true, 30_000)
}

/**
 * Forward one upgrade to the harness and pipe the resulting sockets together.
 * @param req - the upgrade request.
 * @param socket - the client socket, still holding the handshake.
 * @param head - bytes the client already sent past the handshake.
 * @param target - the loopback harness.
 * @param ledger - registry the established socket pair joins.
 */
export function forwardUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: UpstreamTarget,
  ledger: SocketLedger,
): void {
  const upstream = httpRequest({
    host: target.host,
    port: target.port,
    method: req.method ?? 'GET',
    path: req.url ?? '/',
    headers: upstreamHeaders(req.headers, loopbackAuthority(target), { keepUpgrade: true }),
    agent: false,
  })

  const abandon = (): void => {
    upstream.destroy()
    if (!socket.destroyed) socket.destroy()
  }

  socket.on('error', abandon)
  upstream.on('error', () => {
    if (!socket.destroyed) rejectUpgrade(socket, 502, 'Bad Gateway')
    upstream.destroy()
  })

  // The harness answers a non-upgradeable path with an ordinary response; the
  // client asked for a socket, so there is nothing to pipe.
  upstream.on('response', (response) => {
    const status = response.statusCode ?? 502
    rejectUpgrade(socket, status, response.statusMessage ?? 'Upgrade Failed')
    response.destroy()
  })

  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}`]
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue
      for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)

    tune(socket)
    tune(upstreamSocket)
    ledger.track(socket)
    ledger.track(upstreamSocket)

    upstreamSocket.on('error', abandon)
    socket.removeListener('error', abandon)
    socket.on('error', () => { upstreamSocket.destroy() })
    upstreamSocket.on('close', () => { socket.destroy() })
    socket.on('close', () => { upstreamSocket.destroy() })

    // Replay the bytes each side already had in hand before the pipes are
    // wired, or a client that pipelined its first frame loses it.
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)

    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })

  upstream.end()
}
