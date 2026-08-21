/**
 * The relay's card on the harness's **Plugin configuration** tab.
 *
 * What belongs here and what does not: pairing, revocation, and the
 * certificate pin live on the relay's own pages, because they must work before
 * a person is signed in and from a device that is not this one. This card is
 * the configuration surface — the switches that change how the relay behaves —
 * plus the way in to those pages.
 *
 * The card is only ever rendered on loopback. The harness decides whether a
 * settings namespace is writable from `connection.isLoopback`, computed in the
 * browser from the page address, so a remote browser is served no namespaces
 * and this tab dispatches no cards at all. The snapshot's `writable` flag is
 * what that looks like from in here.
 * @module dsh-relay/client/RelayCard
 */

import css from './RelayCard.module.css'

/** One switch the card offers. */
interface Choice {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly options: readonly { readonly value: string, readonly label: string }[]
}

/** The switches, in the order a person reasons about them. */
const CHOICES: readonly Choice[] = [
  {
    field: 'privilegedMethods',
    label: 'Configuration access for remote clients',
    hint: 'The harness serves settings, credentials, model discovery, and its directory pickers only to the machine it runs on. This decides whether an authenticated remote client reaches them too. Clients admitted by network address never do.',
    options: [
      { value: 'allow-authenticated', label: 'Allow once authenticated' },
      { value: 'loopback-only', label: 'This machine only' },
    ],
  },
  {
    field: 'uiLink',
    label: 'Relay link in this UI',
    hint: 'The small link in the corner that reaches the relay pages.',
    options: [{ value: 'true', label: 'Shown' }, { value: 'false', label: 'Hidden' }],
  },
  {
    field: 'mdns',
    label: 'Announce on the local network',
    hint: 'Publishes _dsh._tcp so a client can find this relay without scanning the subnet.',
    options: [{ value: 'true', label: 'Announced' }, { value: 'false', label: 'Quiet' }],
  },
]

/** The relay configuration this card reads. */
interface RelayValue {
  readonly bind?: string
  readonly port?: number
  readonly tls?: string
  readonly privilegedMethods?: string
  readonly uiLink?: boolean
  readonly mdns?: boolean
  readonly compat?: { readonly addressGrants?: boolean, readonly plainPort?: number }
}

/** The snapshot the renderer binds from the settings scope. */
interface RelaySnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly value: RelayValue | undefined
  readonly writable: boolean
}

/** Props the renderer composes for this card. */
export interface RelayCardProps {
  /** Bound from the injected `hooks` compartment. */
  useRelayCard: <T>(select: (snapshot: RelaySnapshot) => T) => T
  /** Write one top-level field of the namespace. */
  setField: (field: string, value: unknown) => void
}

/** Parse the string a `<select>` carries back into the value the field holds. */
function parseChoice(field: string, raw: string): unknown {
  if (field === 'privilegedMethods') return raw
  return raw === 'true'
}

/** Render the value currently in effect for one choice. */
function currentChoice(field: string, value: RelayValue | undefined): string {
  if (field === 'privilegedMethods') return value?.privilegedMethods ?? 'allow-authenticated'
  if (field === 'uiLink') return String(value?.uiLink ?? true)
  return String(value?.mdns ?? true)
}

/**
 * Render the relay's configuration card.
 * @param props - the bound snapshot hook and the field writer.
 * @returns the card.
 */
export function RelayCard(props: RelayCardProps) {
  const snapshot = props.useRelayCard(current => current)
  const value = snapshot.value
  const disabled = !snapshot.writable

  if (snapshot.status === 'loading') {
    return <p className={css.hint}>Loading the relay configuration…</p>
  }

  const scheme = value?.tls === 'off' ? 'http' : 'https'
  const port = value?.port ?? 3443
  const plainPort = value?.compat?.plainPort ?? 0

  return (
    <details className={css.card} open>
      {/* The section's own card chrome is a component of another plugin, and a
          cross-plugin value import is neither resolvable through the module
          table nor permitted, so the card renders its own. `details` gives the
          same collapse the neighbouring cards have with no state to hold. */}
      <summary className={css.summary}>
        <span className={css.name}>Relay</span>
        <span className={css.sub}>Remote access to this harness</span>
      </summary>
      <div className={css.row}>
        <div className={css.meta}>
          <span className={css.name}>Listening</span>
          <span className={css.sub}>
            {`${scheme}://<this machine>:${String(port)}`}
            {value?.bind === '127.0.0.1' ? ' — loopback only, no device can reach it' : ''}
          </span>
        </div>
      </div>

      <div className={css.row}>
        <div className={css.meta}>
          <span className={css.name}>Transport</span>
          <span className={css.sub}>
            {value?.tls === 'off'
              ? 'Plaintext — anything on the network path can read the traffic and the credentials on it'
              : value?.tls === 'files'
                ? 'A certificate you supplied'
                : 'Self-signed, with a pin published on the pairing page'}
          </span>
        </div>
      </div>

      {plainPort > 0 && (
        <div className={css.warn}>
          {`A plain listener is running on port ${String(plainPort)} for DSH Mobile 0.5.0. It carries no configuration access, and the clients it admits are recognised by network address rather than a credential.`}
        </div>
      )}

      {CHOICES.map(choice => (
        <div className={css.row} key={choice.field}>
          <div className={css.meta}>
            <span className={css.name}>{choice.label}</span>
            <span className={css.sub}>{choice.hint}</span>
          </div>
          <select
            aria-label={choice.label}
            disabled={disabled}
            value={currentChoice(choice.field, value)}
            onChange={(event) => { props.setField(choice.field, parseChoice(choice.field, event.target.value)) }}
          >
            {choice.options.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      ))}

      <div className={css.actions}>
        <a href="/relay/pair">Pair a device</a>
        <a href="/relay/devices">Paired devices</a>
        <a href="/relay/password">Change the password</a>
      </div>

      <p className={css.hint}>
        Saving any of these rebinds the listeners, which drops connections in flight — a phone
        mid-session reconnects on its own.
      </p>
    </details>
  )
}
