/**
 * dsh-relay — authenticated remote access to a DeepSeek Harness web profile.
 *
 * The harness serves its browser API on loopback and says plainly that its
 * `/api` trust fence "is not an auth layer", that its configuration plane
 * stays loopback-only "until a real authentication layer exists", and that
 * `--host 0.0.0.0` is refused because it "would expose remote code execution
 * to the network". This plugin is that missing layer, mounted beside the
 * harness rather than inside it.
 *
 * It starts its own listener, authenticates, and reverse-proxies to the
 * untouched loopback web server. The harness keeps its shipped bind, so a
 * failed or misconfigured relay leaves the harness unreachable from the
 * network rather than open to it.
 *
 * Everything registered here is an effect, so `dsh plugin remove`, a config
 * edit, or a hot reload closes the listeners, withdraws the mDNS record, and
 * stops the throttles without leaving a port bound.
 * @module dsh-relay
 */

import type { Context } from '@deepseek-ai/cordis'
// Activates the `ctx.webServer` Context merge. Type-only on purpose: this
// plugin reads every harness capability through `ctx`, so it carries no
// runtime dependency on a harness package and one build runs against any
// release that still provides the services it injects.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Authenticator } from './auth/index.ts'
import { assertCoherent, Config, plainConfig, type ConfigSchema } from './config.ts'
import { injectRelayLink } from './badge.ts'
import { assertTrustedAuthority, isLoopbackAddress, localAddresses, relayAuthorities } from './fence.ts'
import { HarnessSessionResolver } from './harness-session.ts'
import { advertise } from './mdns.ts'
import { relayStateDir } from './paths.ts'
import { followSettings } from './settings-section.ts'
import { RELAY_PREFIX } from './routes.ts'
import { injectSecureContextShim } from './secure-context.ts'
import { startListener, type RelayRuntime } from './server.ts'
import { RelayStore } from './state.ts'
import { certificateSans, loadCertificate } from './tls.ts'

export { Config, plainConfig } from './config.ts'
export type { CompatConfig, ConfigSchema, PrivilegedPolicy, TlsMode } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'relay'

/** The harness web server this relay fronts. */
export const inject = ['webServer']

/**
 * The plugin object the Cordis loader registers, and the only reason this
 * module has a default export.
 *
 * The loader normalizes a module's exports down to a single plugin object —
 * `unwrapExports` is `exports.default ?? exports` — and then caches the
 * configuration schema off **that** object, as `{ name, callback, fibers,
 * Config: plugin.Config }`. The harness's settings plane reads it back with
 * `entry.fiber.runtime.Config` to decide whether an entry is an editable
 * namespace at all.
 *
 * A module that exports a bare `apply` **function** therefore has no `.Config`
 * for anyone to find, and its entry is invisible to the Plugins page no matter
 * how correct the rest is: the Host serves no namespace, and the browser card
 * has nothing to attach to. Verified against dsh 0.1.7-rc.2, where this plugin
 * with only the named exports contributes **zero** namespaces to
 * `settings/describe`.
 */
export default { name, inject, apply, Config }

/** The relay's own logging, degraded to the console when no logger is mounted. */
function loggerFor(ctx: Context): { info: (message: string) => void, warn: (message: string) => void } {
  const logger = ctx.get('logger') as undefined | {
    info?: (message: string) => void
    warn?: (message: string) => void
  }
  return {
    info: message => void (logger?.info?.(`[dsh-relay] ${message}`) ?? console.log(`[dsh-relay] ${message}`)),
    warn: message => void (logger?.warn?.(`[dsh-relay] ${message}`) ?? console.warn(`[dsh-relay] ${message}`)),
  }
}

/**
 * Mount the relay.
 * @param ctx - plugin context; `ctx.webServer` is the harness listener to front.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: ConfigSchema): void {
  const initial = plainConfig(config)
  assertCoherent(initial)
  for (const entry of [...initial.trustedHosts, ...initial.publicHostnames]) assertTrustedAuthority(entry)

  assertFrontable(ctx.webServer)

  const log = loggerFor(ctx)

  ctx.effect(() => {
    const supervisor = new Supervisor(ctx, log)
    // The schema resolves each `.volatile()` field to a live handle, so the
    // running configuration is read through them on every use rather than
    // captured once. An edit swaps the values under these handles, and the
    // loader's notification is what turns that into a rebind.
    const read = (): Config => plainConfig(config)
    followSettings(ctx, () => { supervisor.apply(read()) })
    supervisor.apply(read())
    return async () => { await supervisor.stop() }
  }, 'dsh-relay: listeners')
}

/**
 * Refuse to stand in front of a harness that does not need — or cannot take —
 * a relay.
 *
 * The relay is a fence in front of a loopback server. If the harness already
 * answers the network itself, the relay is decoration in front of an open
 * door: an older harness could be rebound to `0.0.0.0` by the old DSH
 * Mobile LAN patch, and from 0.2.1 the web server binds any concrete interface
 * address it is given. Either way the operator would be told the harness is
 * protected when it is not, so the load fails loudly instead.
 *
 * A loopback harness serving TLS is refused for a plainer reason: the relay
 * terminates TLS itself and forwards plain HTTP over loopback, which a TLS
 * listener cannot answer.
 * @param webServer - the harness listener this relay would front.
 * @param webServer.host - its configured bind address.
 * @param webServer.protocol - its protocol, on harnesses that can serve TLS.
 * @throws {Error} naming what to change.
 */
function assertFrontable(webServer: { readonly host: string, readonly protocol?: string }): void {
  if (!isLoopbackAddress(webServer.host)) {
    throw new Error(
      `dsh-relay: the harness web server is bound to ${webServer.host}, so it is already reachable without `
      + 'going through this relay, which would protect nothing. Remove the webserver row override that '
      + 'sets its host (the DSH Mobile LAN patch sets 0.0.0.0) so the harness stays on 127.0.0.1, and restart.',
    )
  }
  if (webServer.protocol === 'https:') {
    throw new Error(
      'dsh-relay: the harness web server is configured with tls, but the relay terminates TLS itself and '
      + 'forwards plain HTTP over loopback. Remove tls from the webserver row and configure the relay\'s '
      + 'own `tls` instead.',
    )
  }
}

/**
 * Keeps exactly one relay running across configuration changes.
 *
 * A settings edit replaces the whole resolved configuration, including the
 * listen ports, so the response is to tear the listeners down and bind again.
 * Every transition runs on one chain: overlapping edits would otherwise race
 * to bind the same port, and re-listening before the previous close has
 * settled fails with EADDRINUSE. A generation counter lets a superseded
 * transition drop out instead of starting a relay nobody asked for.
 */
class Supervisor {
  #generation = 0
  #chain: Promise<void> = Promise.resolve()
  #running: RunningRelay | undefined
  #applied: string | undefined

  /**
   * @param ctx - the plugin context passed through to each launch.
   * @param log - the relay's logging.
   */
  constructor(
    private readonly ctx: Context,
    private readonly log: { info: (message: string) => void, warn: (message: string) => void },
  ) {}

  /**
   * Run the relay under a new configuration, replacing any current one.
   *
   * An unusable configuration leaves the running relay alone rather than
   * taking it down: a typo in a settings form should not cost the operator
   * their remote access until they can reach the machine to fix it.
   * @param config - the newly resolved configuration.
   */
  apply(config: Config): void {
    try {
      assertCoherent(config)
    } catch (error) {
      this.log.warn(`ignoring an unusable configuration, keeping the running one: ${String(error)}`)
      return
    }
    // The settings service attaching re-reports the value the relay is already
    // running under. Rebinding on that would drop every live connection —
    // including the WebSocket downlinks a phone is mid-session on — for no
    // change at all, so an identical configuration is a no-op.
    const fingerprint = JSON.stringify(config)
    if (fingerprint === this.#applied) return
    this.#applied = fingerprint
    const mine = ++this.#generation
    this.#chain = this.#chain.then(async () => {
      if (mine !== this.#generation) return
      await this.#running?.stop()
      this.#running = undefined
      if (mine !== this.#generation) return
      try {
        this.#running = await start(this.ctx, config, this.log)
      } catch (error) {
        this.log.warn(`failed to start: ${String(error)}`)
      }
    }, () => undefined)
  }

  /**
   * Stop for good.
   * @returns resolution once the last transition has settled and the listeners are closed.
   */
  async stop(): Promise<void> {
    this.#generation += 1
    await this.#chain
    await this.#running?.stop()
    this.#running = undefined
  }
}

/** A running relay and the handle that tears it down. */
interface RunningRelay {
  stop: () => Promise<void>
}

/**
 * Open the state store, load the certificate, and bind the listeners.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @param log - the relay's logging.
 * @returns the running relay.
 */
async function start(
  ctx: Context,
  config: Config,
  log: { info: (message: string) => void, warn: (message: string) => void },
): Promise<RunningRelay> {
  // The web server reports `port` as undefined until it has bound (0.2.1
  // widened the type for a zero config, which asks the operating system for
  // one). The relay proxies to one concrete port, so a mount that precedes the
  // bind is a harness ordering change to fail loudly about, not forward nowhere.
  const upstreamPort = ctx.webServer.port
  if (upstreamPort === undefined) {
    throw new Error(
      'dsh-relay: the harness web server has not bound a port yet, so the relay has no upstream '
      + 'to proxy to. This is a mount-ordering change in the harness, not a configuration error.',
    )
  }

  const dir = relayStateDir(ctx, config.stateDir)
  const store = await RelayStore.open(dir)
  const auth = new Authenticator(store, config)

  const sans = certificateSans(config.publicHostnames)
  const material = await loadCertificate({
    mode: config.tls,
    dir,
    certPath: config.tlsCertPath,
    keyPath: config.tlsKeyPath,
    sans,
    existing: store.state.certificate,
  })
  // A same-key re-issue keeps the fingerprint but moves the covered
  // addresses, so persist the record when either changed — or the next start
  // re-issues for nothing against a record that no longer describes the file.
  const previousCertificate = store.state.certificate
  if (material !== undefined
    && (material.record.fingerprint !== previousCertificate?.fingerprint
      || material.record.sans.join(',') !== previousCertificate?.sans.join(','))) {
    await store.update((draft) => { draft.certificate = material.record })
  }

  // Harness 0.1.2 authenticates its whole `/api` surface, and the relay strips
  // the client's own cookie on the way upstream — so without a session of its
  // own every proxied request is answered 401. The secret is read from the
  // request path, not once here: on a cold start it may not exist yet, and the
  // first request after it does must already carry it.
  let missedAtStart = false
  const session = new HarnessSessionResolver(ctx, () => {
    if (missedAtStart) log.info('harness browser session is available; proxied requests now authenticate')
  })
  if (await session.current() === undefined) {
    missedAtStart = true
    log.info(
      'no harness browser-session secret yet; requests are forwarded unauthenticated until the harness '
      + 'writes it, and each one looks again, so no reload is needed.',
    )
  }

  const runtime: RelayRuntime = {
    auth,
    config,
    target: {
      host: '127.0.0.1',
      port: upstreamPort,
      timeoutMs: config.proxyTimeoutMs,
      session,
    },
    fingerprint: material?.record.fingerprint,
    log: message => { log.warn(message) },
  }

  const authorities = relayAuthorities(config)
  const primary = await startListener({ runtime, bind: config.bind, port: config.port, tls: material, authorities })

  const compat = config.compat.plainPort === 0
    ? undefined
    : await startListener({
      runtime,
      bind: config.bind,
      port: config.compat.plainPort,
      compat: true,
      authorities,
    })
  if (compat !== undefined) runtime.plainPort = compat.port

  const scheme = material === undefined ? 'http' : 'https'

  // Two registrations on the harness's own web server, both needing the port
  // the relay actually bound (`port: 0` asks the operating system to choose).
  //
  // The redirect is what makes `/relay/...` work on the harness's own loopback
  // port at all. Nothing else claims that prefix there, so without it the
  // single-page application's catch-all answers and routes the person back to
  // the chat — a dead end for a typed URL and for the link below alike. A
  // request arriving through the relay never reaches this route, because the
  // relay serves `/relay` itself and forwards only what it does not own.
  const unroute = ctx.webServer.register({
    kind: 'prefix',
    path: RELAY_PREFIX,
    handler: (req, res) => {
      const host = typeof req.headers.host === 'string' ? req.headers.host : '127.0.0.1'
      const hostname = host.replace(/:\d+$/, '')
      const target = `${scheme}://${hostname}:${String(primary.port)}${req.url ?? RELAY_PREFIX}`
      res.writeHead(302, { location: target, 'cache-control': 'no-store' })
      res.end()
    },
  })
  const untap = config.uiLink ? ctx.webServer.tapIndex(injectRelayLink) : () => undefined
  // Unconditional, and inert wherever it is not needed: the shim defines
  // nothing when the real `crypto.randomUUID` is there, which is every TLS
  // deployment and the harness's own loopback port. Gating it on the
  // plaintext paths instead would tie a browser's ability to hold a
  // connection to a configuration field nothing else connects it to.
  const untapShim = ctx.webServer.tapIndex(injectSecureContextShim)
  // Every address, not a guess at the best one: a machine with a
  // virtual-machine or VPN adapter alongside real Wi-Fi has several, and the
  // first one the operating system reports is regularly the one a phone has
  // no route to.
  const reachable = ['127.0.0.1', ...localAddresses()]
    .map(address => `${scheme}://${address}:${String(primary.port)}`)
    .join(' ')
  log.info(`listening on ${reachable} (harness on 127.0.0.1:${String(upstreamPort)})`)
  if (material === undefined) {
    log.warn('serving plaintext: anything on the network path can read this traffic and the credentials on it')
  }
  if (compat !== undefined) {
    log.warn(`plain compatibility listener on port ${String(compat.port)}: DSH Mobile 0.5.0 only, no configuration access`)
  }
  if (!auth.hasPassword) {
    log.info(`no password set yet — open ${scheme}://127.0.0.1:${String(primary.port)}/relay/password on this machine to set one`)
  }

  const unadvertise = config.mdns
    ? await advertise({
      port: primary.port,
      plainPort: compat?.port,
      tls: config.tls,
      fingerprint: material?.record.fingerprint,
      name: config.mdnsName,
    }, message => { log.warn(message) })
    : async () => undefined

  return {
    // One disposer, in reverse order of construction: cordis runs multiple
    // async disposers concurrently with no completion ordering, so anything
    // order-dependent belongs inside a single one.
    stop: async () => {
      untapShim()
      untap()
      unroute()
      await unadvertise()
      await compat?.close()
      await primary.close()
      auth.dispose()
      await store.close()
    },
  }
}
