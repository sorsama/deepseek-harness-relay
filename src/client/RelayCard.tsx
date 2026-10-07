/**
 * The relay's card on the harness's **Plugins** page.
 *
 * What belongs here and what does not: pairing, revocation, and the
 * certificate pin live on the relay's own pages, because they must work before
 * a person is signed in and from a device that is not this one. This card is
 * the configuration surface — the switches that change how the relay behaves —
 * plus the way in to those pages.
 *
 * **The platform draws the card.** On dsh 0.1.7 the Plugins page supplies the
 * title button, the disclosure chevron, and the frame, and asks this component
 * for two things only: a one-liner when `view` is `summary`, and the form body
 * when it is `page` — which is `SettingsForm` plus the fields. Drawing an outer
 * `<li>` with its own header here, as the 0.1.5 card did, produces a doubled
 * card whose inner button sits over the platform's and swallows its clicks.
 *
 * The card is only ever rendered on loopback. The harness decides whether a
 * settings namespace is writable from `connection.isLoopback`, computed in the
 * browser from the page address, so a remote browser is served no namespaces
 * and this page dispatches no cards at all. The snapshot's `writable` flag is
 * what that looks like from in here.
 *
 * Edits are staged and written on save, as the neighbouring cards do. That is
 * not only for consistency: saving a relay field rebinds the listeners and
 * drops the connections in flight, so a control that committed as it settled
 * turned one change of mind into several disconnections.
 * @module dsh-relay/client/RelayCard
 */

import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './RelayCard.module.css'

/** One setting the card exposes as a free-text or whole-number field. */
interface Field {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly numeric: boolean
}

/**
 * The fields the card edits, in the order a person reasons about them.
 *
 * These must stay in step with the specs the client half registers on the form
 * model: a field with a control but no spec renders, accepts typing, and then
 * silently refuses to save, because the model plans its writes from the specs
 * and not from what is on screen.
 */
const FIELDS: readonly Field[] = [
  {
    field: 'bind',
    label: 'Listen address',
    hint: 'The interface the relay binds. 0.0.0.0 reaches every network this machine is on; 127.0.0.1 makes it unreachable from any device.',
    numeric: false,
  },
  {
    field: 'port',
    label: 'Listen port',
    hint: 'The port the relay serves on. Changing it rebinds the listener.',
    numeric: true,
  },
  {
    field: 'proxyTimeoutMs',
    label: 'Upstream timeout (ms)',
    hint: 'How long a proxied request may wait on the harness before the relay gives up on it.',
    numeric: true,
  },
  {
    field: 'rateLimitPerMinute',
    label: 'Requests per minute',
    hint: 'Requests allowed per minute from one source address, across every path.',
    numeric: true,
  },
]

/** One switch the card offers, as a segmented control over a string field. */
interface Choice {
  readonly field: string
  readonly label: string
  readonly hint: string
  readonly options: readonly { readonly value: string, readonly label: string }[]
}

/** The switches, after the fields. */
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
export interface RelayValue {
  readonly bind?: string
  readonly port?: number
  readonly tls?: string
  readonly privilegedMethods?: string
  readonly uiLink?: boolean
  readonly mdns?: boolean
  readonly compat?: { readonly addressGrants?: boolean, readonly plainPort?: number }
}

/** One staged field, as the shared form model reports it. */
export interface FieldState {
  readonly text: string
  readonly overridden: boolean
  readonly invalid: boolean
}

/** The card-level state the shared form model reports. */
export interface Shell {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
}

/** The projection the renderer's bound hook returns. */
export interface RelayCardState extends Shell {
  readonly value: RelayValue | undefined
  readonly bind: FieldState
  readonly port: FieldState
  readonly proxyTimeoutMs: FieldState
  readonly rateLimitPerMinute: FieldState
}

/** Props the renderer composes for this card. */
export interface RelayCardProps {
  /** Which part of the card the platform is asking for. */
  view?: 'summary' | 'page'
  /** Bound from the injected `hooks` compartment. */
  useRelayCard: <T>(select: (state: RelayCardState) => T) => T
  /** Stage draft text for one section field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/**
 * Render the value currently in effect for one choice.
 * @param choice - the switch being read.
 * @param value - the staged section value.
 * @returns the option string the control should show as selected.
 */
function currentChoice(choice: Choice, value: RelayValue | undefined): string {
  if (choice.field === 'privilegedMethods') return value?.privilegedMethods ?? 'allow-authenticated'
  if (choice.field === 'uiLink') return String(value?.uiLink ?? true)
  return String(value?.mdns ?? true)
}

/**
 * Render the relay's configuration card.
 * @param props - the bound snapshot hook and the form actions.
 * @returns the one-liner or the form; the platform supplies the frame.
 */
export function RelayCard(props: RelayCardProps) {
  const state = props.useRelayCard(current => current)

  // The summary is the row's one-liner. Without it the list falls back to the
  // package's npm description, which reads as a styling bug rather than a
  // missing implementation.
  if (props.view === 'summary') {
    return 'Authenticated remote access: TLS, device pairing, and per-device revocation.'
  }

  const value = state.value
  const disabled = !state.writable
  const scheme = value?.tls === 'off' ? 'http' : 'https'
  const plainPort = value?.compat?.plainPort ?? 0

  return (
    <SettingsForm
      labels={{
        unavailable: 'This plugin is not loaded, so it cannot be configured.',
        readOnly: 'This deployment stores settings read-only.',
        saveFailed: 'This deployment did not accept those values. They are still staged.',
        save: 'Save',
        saving: 'Saving…',
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      {FIELDS.map(field => (
        <SettingsValueField
          key={field.field}
          id={`plugin-config-relay-${field.field}`}
          label={field.label}
          hint={field.hint}
          overriddenLabel="Overridden"
          resetLabel="Reset"
          invalidLabel="Enter a number, or leave blank to use the default."
          numeric={field.numeric}
          disabled={disabled}
          {...state[field.field as keyof RelayCardState] as FieldState}
          onEdit={(text) => { props.edit(field.field, text) }}
          onReset={() => { props.resetField(field.field) }}
        />
      ))}

      <div className={css.field}>
        <span className={css.label}>Listening</span>
        <span className={css.value}>
          {`${scheme}://<this machine>:${String(value?.port ?? 3443)}`}
          {value?.bind === '127.0.0.1' ? ' — loopback only, no device can reach it' : ''}
        </span>
      </div>

      <div className={css.field}>
        <span className={css.label}>Transport</span>
        <span className={css.value}>
          {value?.tls === 'off'
            ? 'Plaintext — anything on the network path can read the traffic and the credentials on it'
            : value?.tls === 'files'
              ? 'A certificate you supplied'
              : 'Self-signed, with a pin published on the pairing page'}
        </span>
      </div>

      {plainPort > 0 && (
        <div className={css.warn}>
          {`A plain listener is running on port ${String(plainPort)} for DSH Mobile 0.5.0. It carries no configuration access, and the clients it admits are recognised by network address rather than a credential.`}
        </div>
      )}

      {CHOICES.map(choice => (
        <div className={css.field} key={choice.field}>
          <span className={css.label}>{choice.label}</span>
          <div className={css.segmented} role="group" aria-label={choice.label}>
            {choice.options.map((option) => {
              const on = option.value === currentChoice(choice, value)
              return (
                <button
                  type="button"
                  key={option.value}
                  className={on ? `${css.segment} ${css.segmentOn}` : css.segment}
                  aria-pressed={on}
                  disabled={disabled || state.saving}
                  onClick={() => { props.edit(choice.field, option.value) }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
          <p className={css.hint}>{choice.hint}</p>
        </div>
      ))}

      <div className={css.actions}>
        <a className={css.action} href="/relay/pair">Pair a device</a>
        <a className={css.action} href="/relay/devices">Paired devices</a>
        <a className={css.action} href="/relay/password">Change the password</a>
      </div>

      <p className={css.hint}>
        Saving rebinds the listeners, which drops connections in flight — a phone mid-session
        reconnects on its own.
      </p>
    </SettingsForm>
  )
}
