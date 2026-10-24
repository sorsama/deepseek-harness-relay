/**
 * Request forwarding to the loopback harness.
 *
 * Bodies stream in both directions and are never buffered: `session.export`
 * answers a ZIP with no content length, and a chat turn's response is read
 * while the model is still producing it.
 * @module dsh-relay/proxy/http
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HarnessSession } from '../harness-session.ts'
import { downstreamHeaders, upstreamHeaders } from './rewrite.ts'

/** What the forwarder needs to reach the harness. */
export interface UpstreamTarget {
  /** Loopback host the harness web server listens on. */
  readonly host: string
  /** Loopback port the harness web server listens on. */
  readonly port: number
  /** Deadline for the upstream response to begin. */
  readonly timeoutMs: number
  /**
   * Mints the harness browser session each forwarded request carries.
   *
   * Read **per request**, not captured when the listener bound. A cold start
   * mounts this plugin before `dsh-client-connection` has written its signing
   * secret, and a value captured once would freeze that single miss into every
   * later request — the failure mode where the relay's own pages keep working
   * while every proxied call is answered 401, which reaches a phone as "the
   * stream would not open".
   *
   * Returns undefined against a harness older than 0.1.2, which required none,
   * and during the first moments of a cold start on 0.1.2 or later.
   * @returns the minter, or undefined while the harness has no such secret.
   */
  session: () => HarnessSession | undefined
}

/** The authority the harness sees, and compares its own fence against. */
export function loopbackAuthority(target: UpstreamTarget): string {
  return `${target.host}:${String(target.port)}`
}

/**
 * Forward one request and stream its response back.
 * @param req - the inbound request; its body is piped upstream.
 * @param res - the response to write; owned entirely by this call.
 * @param target - the loopback harness.
 * @returns resolution once the response is finished or an error was reported.
 */
export function forward(req: IncomingMessage, res: ServerResponse, target: UpstreamTarget): Promise<void> {
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers: upstreamHeaders(req.headers, loopbackAuthority(target), {
        cookie: target.session()?.cookieFor(loopbackAuthority(target)),
      }),
      // Each proxied request gets its own socket rather than sharing the
      // global agent's pool, so one stalled streaming response cannot hold a
      // slot another request is waiting for.
      agent: false,
    })
    upstream.setTimeout(target.timeoutMs, () => {
      upstream.destroy(new Error('dsh-relay: upstream timed out'))
    })

    const fail = (status: number, message: string): void => {
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(message)
      } else {
        res.destroy()
      }
      resolve()
    }

    upstream.on('error', () => { fail(502, 'upstream unavailable') })
    upstream.on('response', (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, downstreamHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
      upstreamRes.on('error', () => { res.destroy() })
      res.on('close', () => { upstreamRes.destroy() })
      upstreamRes.on('end', () => { resolve() })
    })

    req.on('error', () => { upstream.destroy() })
    req.pipe(upstream)
  })
}
