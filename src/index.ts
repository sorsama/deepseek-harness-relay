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
import { assertTrustedAuthority, localAddresses, relayAuthorities } from './fence.ts'
import { HarnessSession } from './harness-session.ts'
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

  // The relay is a fence in front of a loopback server. If the harness is
  // already answering the network itself, the relay is decoration in front of
  // an open door — and the operator almost certainly still has the old
  // unauthenticated LAN patch applied. Fail the load loudly rather than
  // implying a protection that is not there.
  if (ctx.webServer.host === '0.0.0.0') {
    throw new Error(
      'dsh-relay: the harness web server is bound to 0.0.0.0, so it is already reachable without '
      + 'authentication and this relay would protect nothing. Remove the webserver row override that '
      + 'sets host: 0.0.0.0 (the DSH Mobile LAN patch) and restart.',
    )
  }

  const log = loggerFor(ctx)

  ctx.effect(() => {
    const supervisor = new Supervisor(ctx, log)
    // The schema resolves each `.volatile()` field to a live handle, so the
    // running configuration is read through them on every use rather than
    // captured once. A settings write swaps the values under these handles and
    // the event below is what turns that into a rebind.
    const read = (): Config => plainConfig(config)
    followSettings(ctx, { onChange: () => { supervisor.apply(read()) } })
    supervisor.apply(read())
    return async () => { await supervisor.stop() }
  }, 'dsh-relay: listeners')
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
  if (material !== undefined && material.record.fingerprint !== store.state.certificate?.fingerprint) {
    await store.update((draft) => { draft.certificate = material.record })
  }

  // Harness 0.1.2 authenticates its whole `/api` surface, and the relay strips
  // the client's own cookie on the way upstream — so without a session of its
  // own every proxied request is answered 401. An older harness keeps no such
  // secret, and needs none.
  //
  // Resolved lazily, per request, rather than once here. On a cold start this
  // plugin mounts before `dsh-client-connection` has written the secret, and a
  // single read at bind time would freeze that one miss into every later
  // request: the relay's own pages keep working, and every proxied call is
  // answered 401 for the life of the process. That is a real failure this
  // deployment used to paper over with a post-start script that edited the
  // config purely to force a reload.
  const resolver = HarnessSession.lazy(ctx)
  // One probe at mount to report the situation, without making the answer
  // permanent: the same resolver serves every request from here on.
  await resolver.current()
  if (!resolver.ready) {
    log.info(
      'no harness browser-session secret yet; forwarding unauthenticated until it appears. That is '
      + 'correct for a harness before 0.1.2. On 0.1.2 or later the harness writes that secret once it '
      + 'has started, and the relay picks it up on the next request without a reload.',
    )
  }

  const runtime: RelayRuntime = {
    auth,
    config,
    target: {
      host: '127.0.0.1',
      port: ctx.webServer.port,
      timeoutMs: config.proxyTimeoutMs,
      // Synchronous by contract, so the async read is refreshed here and the
      // request path stays a plain lookup. Every forwarded request re-reads
      // through this, which is what lets a cold start recover on its own.
      session: () => resolver.sync(),
    },
    fingerprint: material?.record.fingerprint,
    log: message => { log.warn(message) },
  }

  // Keep the synchronous view current for a harness whose secret arrives after
  // mount, so a cold start heals without waiting for a settings edit. The read
  // is cheap (a memoized map lookup once the value is known) and stops as soon
  // as it has succeeded.
  const poll = setInterval(() => {
    if (resolver.ready) {
      clearInterval(poll)
      if (resolver.markRecovered()) {
        log.info('harness browser session is available; proxied requests now authenticate')
      }
      return
    }
    void resolver.current()
  }, 1_000)
  // Do not hold the process open for this alone.
  poll.unref?.()


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
  log.info(`listening on ${reachable} (harness on 127.0.0.1:${String(ctx.webServer.port)})`)
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
      clearInterval(poll)
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
