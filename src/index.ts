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
import { assertCoherent, Config } from './config.ts'
import { assertTrustedAuthority, localAddresses, relayAuthorities } from './fence.ts'
import { advertise } from './mdns.ts'
import { relayStateDir } from './paths.ts'
import { startListener, type RelayRuntime } from './server.ts'
import { RelayStore } from './state.ts'
import { certificateSans, loadCertificate } from './tls.ts'

export { Config } from './config.ts'
export type { CompatConfig, PrivilegedPolicy, TlsMode } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'relay'

/** The harness web server this relay fronts. */
export const inject = ['webServer']

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
export function apply(ctx: Context, config: Config): void {
  assertCoherent(config)
  for (const entry of [...config.trustedHosts, ...config.publicHostnames]) assertTrustedAuthority(entry)

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
    const started = start(ctx, config, log)
    // The effect's disposer must await teardown: cordis reloads this plugin on
    // a config edit, and re-listening on a port whose previous server has not
    // finished closing fails with EADDRINUSE.
    return async () => {
      const running = await started.catch(() => undefined)
      await running?.stop()
    }
  }, 'dsh-relay: listeners')
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

  const runtime: RelayRuntime = {
    auth,
    config,
    target: {
      host: '127.0.0.1',
      port: ctx.webServer.port,
      timeoutMs: config.proxyTimeoutMs,
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
  if (compat !== undefined) {
    runtime.plainOrigin = `http://${localAddresses()[0] ?? '127.0.0.1'}:${String(compat.port)}`
  }

  const scheme = material === undefined ? 'http' : 'https'
  const reachable = localAddresses()[0] ?? '127.0.0.1'
  log.info(`listening on ${scheme}://${reachable}:${String(primary.port)} (harness on 127.0.0.1:${String(ctx.webServer.port)})`)
  if (material === undefined) {
    log.warn('serving plaintext: anything on the network path can read this traffic and the credentials on it')
  }
  if (compat !== undefined) {
    log.warn(`plain compatibility listener on port ${String(compat.port)}: DSH Mobile 0.5.0 only, no configuration access`)
  }
  if (!auth.hasPassword) {
    log.info(`no password set yet — open ${scheme}://127.0.0.1:${String(primary.port)}/relay/login on this machine to set one`)
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
      await unadvertise()
      await compat?.close()
      await primary.close()
      auth.dispose()
      await store.close()
    },
  }
}
