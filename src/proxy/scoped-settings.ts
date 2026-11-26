/**
 * The namespace-scoped settings calls a remote client may make under
 * `privilegedMethods: loopback-only`.
 *
 * The rest of the pinned set is refused on its path alone. These two need the
 * body read, because the path does not say which namespace a call touches:
 *
 * - `settings/mutate` names its namespace in the payload, so the relay parses
 *   the request, refuses any namespace but {@link REMOTE_SETTINGS_NAMESPACE},
 *   and forwards a request it rebuilt from the fields it checked. Forwarding
 *   the client's own bytes instead would leave room for the harness to read
 *   them differently from the relay (a duplicate key, an encoding, a field the
 *   relay ignored); rebuilt, the harness sees exactly what was judged.
 * - `settings/describe` takes no namespace at all and answers every one, with
 *   schemas and values. It is forwarded with empty arguments, and the answer is
 *   cut down to the one namespace before it leaves the relay. An answer the
 *   relay cannot parse is refused rather than passed through, so nothing else
 *   can leak on a malformed or unexpected reply.
 *
 * Both are unary calls on `POST /api/<namespace>/<method>`; the harness refuses
 * to open a unary method over its WebSocket stream carrier, so this path is the
 * only one they can take.
 * @module dsh-relay/proxy/scoped-settings
 */

import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { REMOTE_SETTINGS_NAMESPACE, type ScopedSettingsMethod } from '../privileged.ts'
import { sendJson } from '../wire.ts'
import { loopbackAuthority, type UpstreamTarget } from './http.ts'
import { upstreamHeaders } from './rewrite.ts'

/** Ceiling on a scoped request body: one namespace's edits, far below this in practice. */
const MAX_REQUEST_BYTES = 256 * 1024

/** Ceiling on the upstream answer the relay buffers to filter: every namespace with its schema. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** The arguments `settings/mutate` declares; anything else is refused before the harness sees it. */
const MUTATE_ARGS = new Set(['ns', 'ops', 'expectedRevision'])

/** A plain JSON object, not an array or null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** The media type of a `Content-Type` value, lowercased, without parameters. */
function mediaType(value: string | undefined): string | undefined {
  return value?.split(';', 1)[0]?.trim().toLowerCase()
}

/** A `Content-Encoding` the relay can read as-is: absent, or `identity`. */
function plainEncoding(value: string | string[] | undefined): boolean {
  if (value === undefined) return true
  return typeof value === 'string' && value.trim().toLowerCase() === 'identity'
}

/** Answer a refusal the client contract reads as "this credential cannot reach that". */
function refuseScoped(res: ServerResponse, message: string): void {
  sendJson(res, 403, { error: 'forbidden', message })
}

/**
 * Read a bounded request body.
 * @param req - the inbound request.
 * @returns the body, or undefined when it exceeded the cap.
 */
async function readBounded(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_REQUEST_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** A request the relay rebuilt, or the reason it was refused. */
type Rebuilt =
  | { readonly ok: true, readonly body: Record<string, unknown> }
  | { readonly ok: false, readonly message: string }

/** A refusal, with the sentence the client is shown. */
function refused(message: string): Rebuilt {
  return { ok: false, message }
}

/**
 * Check one client request against the allowance and rebuild it from the
 * checked fields only.
 * @param method - the endpoint the path addressed.
 * @param parsed - the request body, parsed.
 * @returns the envelope to forward, or why it was refused.
 */
export function rebuildScopedRequest(method: ScopedSettingsMethod, parsed: unknown): Rebuilt {
  if (!isPlainObject(parsed)) return refused('the request is not a client-request envelope')
  if (parsed.type !== 'client-request' || typeof parsed.rpcId !== 'string') {
    return refused('the request is not a client-request envelope')
  }
  // The harness requires these to agree too; checking here keeps the relay's
  // reading of the call identical to the harness's.
  if (parsed.method !== method) return refused('the envelope names a different method than the path')
  const payload = parsed.payload
  if (!isPlainObject(payload) || Object.keys(payload).length !== 1 || !isPlainObject(payload.args)) {
    return refused('the payload must hold exactly one args object')
  }
  const args = payload.args
  const envelope = (rebuiltArgs: Record<string, unknown>): Rebuilt => ({
    ok: true,
    body: { type: 'client-request', rpcId: parsed.rpcId, method, payload: { args: rebuiltArgs } },
  })

  if (method === 'settings/describe') {
    // Describe takes no arguments. Accepting any would be accepting arguments
    // a later harness might give meaning the relay never checked.
    if (Object.keys(args).length !== 0) return refused('settings/describe takes no arguments here')
    return envelope({})
  }

  if (Object.keys(args).some(key => !MUTATE_ARGS.has(key))) {
    return refused('settings/mutate carries an argument this relay does not check')
  }
  if (args.ns !== REMOTE_SETTINGS_NAMESPACE) {
    return refused(`only the ${REMOTE_SETTINGS_NAMESPACE} settings namespace is served to this device`)
  }
  if (!Array.isArray(args.ops)) return refused('settings/mutate needs an ops array')
  const expected = args.expectedRevision
  if (Object.hasOwn(args, 'expectedRevision') && expected !== null && typeof expected !== 'number') {
    return refused('expectedRevision must be a number')
  }
  return envelope({
    ns: REMOTE_SETTINGS_NAMESPACE,
    ops: args.ops,
    ...Object.hasOwn(args, 'expectedRevision') && { expectedRevision: expected },
  })
}

/**
 * Cut a `settings/describe` answer down to the one namespace a remote client
 * may read.
 * @param parsed - the upstream answer, parsed.
 * @returns the filtered answer, or undefined when it is not a shape the relay
 * can vouch for.
 */
export function filterDescribeAnswer(parsed: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(parsed) || parsed.type !== 'server-response') return undefined
  const result = parsed.result
  if (!isPlainObject(result)) return undefined
  // A refusal carries a code and a message, never a namespace; it passes so
  // the page can show why the call failed.
  if (result.ok === false) return parsed
  if (result.ok !== true) return undefined
  const value = result.value
  if (!isPlainObject(value) || !Array.isArray(value.namespaces)) return undefined
  const namespaces = value.namespaces.filter(entry => isPlainObject(entry) && entry.ns === REMOTE_SETTINGS_NAMESPACE)
  return { ...parsed, result: { ...result, value: { ...value, namespaces } } }
}

/** One buffered upstream answer. */
interface UpstreamAnswer {
  readonly status: number
  readonly headers: IncomingMessage['headers']
  readonly body: Buffer
}

/**
 * Send one rebuilt request upstream and buffer the answer.
 * @param req - the inbound request, for the headers worth keeping.
 * @param target - the loopback harness.
 * @param body - the rebuilt request body.
 * @returns the answer, or undefined when the harness did not answer usably.
 */
async function exchange(req: IncomingMessage, target: UpstreamTarget, body: Buffer): Promise<UpstreamAnswer | undefined> {
  const authority = loopbackAuthority(target)
  const cookie = await target.session?.cookieFor(authority)
  const headers = upstreamHeaders(req.headers, authority, { cookie })
  // The body is the relay's own now, so its framing is too. And the answer must
  // come back readable: a compressed describe could not be filtered.
  delete headers['content-length']
  delete headers['content-encoding']
  delete headers['accept-encoding']
  delete headers.expect
  headers['content-type'] = 'application/json'
  headers['content-length'] = String(body.length)
  return new Promise((resolve) => {
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: 'POST',
      path: req.url ?? '/',
      headers,
      agent: false,
    })
    upstream.setTimeout(target.timeoutMs, () => { upstream.destroy(new Error('dsh-relay: upstream timed out')) })
    upstream.on('error', () => { resolve(undefined) })
    upstream.on('response', (response) => {
      const chunks: Buffer[] = []
      let total = 0
      response.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy()
          upstream.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      response.on('error', () => { resolve(undefined) })
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) })
      })
    })
    upstream.end(body)
  })
}

/**
 * Write an answer the relay produced or re-encoded.
 * @param res - the response to write.
 * @param status - HTTP status.
 * @param contentType - the media type to declare.
 * @param body - the bytes.
 */
function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Serve one namespace-scoped settings call for a remote client.
 * @param req - the inbound request, already authenticated.
 * @param res - the response, owned entirely by this call.
 * @param method - the scoped endpoint the path addressed.
 * @param target - the loopback harness.
 * @param log - where refusals are reported.
 * @returns resolution once the response is finished.
 */
export async function serveScopedSettings(
  req: IncomingMessage,
  res: ServerResponse,
  method: ScopedSettingsMethod,
  target: UpstreamTarget,
  log: (message: string) => void,
): Promise<void> {
  if (req.method !== 'POST') {
    refuseScoped(res, 'this method is served only to the machine running the harness')
    return
  }
  if (mediaType(req.headers['content-type']) !== 'application/json' || !plainEncoding(req.headers['content-encoding'])) {
    sendJson(res, 415, { error: 'unsupported-media-type', message: 'send an uncompressed application/json body' })
    return
  }
  const raw = await readBounded(req)
  if (raw === undefined) {
    sendJson(res, 413, { error: 'too-large', message: 'Request too large.' })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'bad-request', message: 'body is not JSON' })
    return
  }
  const rebuilt = rebuildScopedRequest(method, parsed)
  if (!rebuilt.ok) {
    log(`refused ${method}: ${rebuilt.message}`)
    refuseScoped(res, rebuilt.message)
    return
  }

  const answer = await exchange(req, target, Buffer.from(JSON.stringify(rebuilt.body), 'utf8'))
  if (answer === undefined) {
    if (!res.headersSent) sendJson(res, 502, { error: 'bad-gateway', message: 'upstream unavailable' })
    return
  }

  const contentType = typeof answer.headers['content-type'] === 'string' ? answer.headers['content-type'] : 'application/octet-stream'
  if (method === 'settings/mutate' || answer.status !== 200) {
    // A mutate answer is the written namespace's own view, and the request was
    // already held to that namespace. A non-200 answer is the harness refusing
    // the transport (401, 404, 415), which names no namespace either way.
    if (!plainEncoding(answer.headers['content-encoding'])) {
      sendJson(res, 502, { error: 'bad-gateway', message: 'the harness answered in an encoding the relay cannot check' })
      return
    }
    sendBytes(res, answer.status, contentType, answer.body)
    return
  }

  // A successful describe is the one answer that carries other namespaces, so
  // it leaves only in a shape the relay parsed and filtered.
  let filtered: Record<string, unknown> | undefined
  if (mediaType(contentType) === 'application/json' && plainEncoding(answer.headers['content-encoding'])) {
    try {
      filtered = filterDescribeAnswer(JSON.parse(answer.body.toString('utf8')))
    } catch {
      filtered = undefined
    }
  }
  if (filtered === undefined) {
    log(`refused ${method}: the harness answered a shape the relay cannot filter`)
    sendJson(res, 502, { error: 'bad-gateway', message: 'the harness answered a shape the relay cannot filter' })
    return
  }
  sendBytes(res, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(filtered), 'utf8'))
}
