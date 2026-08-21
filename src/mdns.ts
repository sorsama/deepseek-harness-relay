/**
 * Local-network advertisement.
 *
 * DSH Mobile finds a harness today by sweeping its own /24 with a TCP knock,
 * because nothing on the network announces itself. Advertising `_dsh._tcp`
 * removes that sweep for any client that learns to look, and the TXT record
 * carries what a client needs before it connects: which port to use, whether
 * the primary listener speaks TLS, the certificate pin to expect, and whether
 * a pairing window is open right now.
 *
 * No shipped client consumes this yet. It is cheap, unloads cleanly, and turns
 * off with one config field.
 * @module dsh-relay/mdns
 */

import { hostname } from 'node:os'

/** The DNS-SD service type the relay publishes under. */
const SERVICE_TYPE = 'dsh'

/** What the advertisement carries. */
export interface Advertisement {
  /** Port of the primary listener. */
  readonly port: number
  /** Port of the plain-HTTP compatibility listener, when one is running. */
  readonly plainPort?: number | undefined
  /** Transport posture of the primary listener. */
  readonly tls: string
  /** SPKI pin of the served certificate, when the listener terminates TLS. */
  readonly fingerprint?: string | undefined
  /** Service instance name; empty derives one from the machine's hostname. */
  readonly name: string
}

/** One published service handle, which reports failures as events. */
interface PublishedService {
  on: (event: 'error', listener: (error: unknown) => void) => void
  stop: (callback?: () => void) => void
}

/** The `bonjour-service` surface this module uses. */
interface BonjourLike {
  publish(options: {
    name: string
    type: string
    port: number
    txt: Record<string, string>
  }): PublishedService
  unpublishAll(callback?: () => void): void
  destroy(): void
}

/**
 * Publish the relay on the local network.
 * @param advertisement - what to announce.
 * @param onError - reports a failure to advertise; advertising is best-effort
 * and must never take the relay down with it.
 * @returns a disposer that withdraws the record.
 */
export async function advertise(
  advertisement: Advertisement,
  onError: (message: string) => void,
): Promise<() => Promise<void>> {
  let bonjour: BonjourLike
  try {
    const module = await import('bonjour-service') as unknown as { Bonjour: new () => BonjourLike }
    bonjour = new module.Bonjour()
  } catch (error) {
    onError(`mDNS unavailable: ${String(error)}`)
    return async () => undefined
  }

  try {
    const service = bonjour.publish({
      // The port is part of the default name because a name collision on the
      // network is reported as a failure, and two relays on one machine — a
      // second harness, or one being tested beside another — are ordinary.
      name: advertisement.name === ''
        ? `DSH Relay on ${hostname()} (${String(advertisement.port)})`
        : advertisement.name,
      type: SERVICE_TYPE,
      port: advertisement.port,
      txt: {
        v: '1',
        relay: 'dsh-relay',
        tls: advertisement.tls,
        ...advertisement.plainPort !== undefined && { plain: String(advertisement.plainPort) },
        ...advertisement.fingerprint !== undefined && { pin: advertisement.fingerprint },
      },
    })
    // A name collision is reported asynchronously, long after publish() has
    // returned. Without this listener the emitter has no handler and the
    // failure escapes as an unhandled error — taking down a process whose
    // relay is otherwise serving perfectly well, over an advertisement that
    // nothing yet consumes.
    service.on('error', (error: unknown) => {
      onError(`mDNS advertisement failed, continuing without it: ${String(error)}`)
    })
  } catch (error) {
    onError(`mDNS publish failed: ${String(error)}`)
    bonjour.destroy()
    return async () => undefined
  }

  return async () => {
    await new Promise<void>((resolve) => {
      // Withdraw the record before tearing the socket down, so a client that
      // is looking right now sees the service leave rather than time out.
      bonjour.unpublishAll(() => { resolve() })
    })
    bonjour.destroy()
  }
}
