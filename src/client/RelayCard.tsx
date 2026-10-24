/**
 * The relay's configuration page on the harness's **Plugins** page.
 *
 * What belongs here and what does not: pairing, revocation, and the
 * certificate pin live on the relay's own pages, because they must work before
 * a person is signed in and from a device that is not this one. This page is
 * the configuration surface — the switches that change how the relay behaves —
 * plus the way in to those pages.
 *
 * **The platform draws the frame.** The Plugins page heads the row's page with
 * the plugin's title and description and asks this component for two things
 * only: a one-liner when `view` is `summary`, and the form body when it is
 * `page` — `SettingsForm` plus the fields. Drawing an outer card with its own
 * header here, as the 0.1.5 card did, produces a doubled frame whose inner
 * button sits over the platform's and swallows its clicks.
 *
 * The page is only ever rendered on loopback. The harness decides whether a
 * settings namespace is served from `connection.isLoopback`, computed in the
 * browser from the page address, so a remote browser is served no namespaces
 * and the row offers no configure control there. The snapshot's `writable`
 * flag is what a read-only deployment looks like from in here.
 *
 * Edits are staged and written on save, as the neighbouring pages do. That is
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
 * The free-text and number fields, in the order a person reasons about them.
 *
 * These and the switches below must stay in step with the specs the client
 * half registers on the form model: staging a field the model has no spec for
 * throws on the next projection, which takes the whole page down.
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

/** One switch the page offers, as a segmented control over a staged field. */
interface Choice {
  readonly field: 'privilegedMethods' | 'uiLink' | 'mdns'
  /** What the field resolves to when the section carries no value of its own. */
  readonly fallback: string
  readonly label: string
  readonly hint: string
  readonly options: readonly { readonly value: string, readonly label: string }[]
}

/** The switches, after the fields. */
const CHOICES: readonly Choice[] = [
  {
    field: 'privilegedMethods',
    fallback: 'allow-authenticated',
    label: 'Configuration access for remote clients',
    hint: 'The harness serves settings, credentials, model discovery, and its directory pickers only to the machine it runs on. This decides whether an authenticated remote client reaches them too. Clients admitted by network address never do.',
    options: [
      { value: 'allow-authenticated', label: 'Allow once authenticated' },
      { value: 'loopback-only', label: 'This machine only' },
    ],
  },
  {
    field: 'uiLink',
    fallback: 'true',
    label: 'Relay link in this UI',
    hint: 'The small link in the corner that reaches the relay pages.',
    options: [{ value: 'true', label: 'Shown' }, { value: 'false', label: 'Hidden' }],
  },
  {
    field: 'mdns',
    fallback: 'true',
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
  readonly privilegedMethods: FieldState
  readonly uiLink: FieldState
  readonly mdns: FieldState
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
 * The option a switch shows as selected: the staged draft when there is one,
 * the stored value otherwise, and the schema default when neither exists.
 * @param choice - the switch being read.
 * @param state - the page's projection.
 * @returns the option string the control should show as selected.
 */
function currentChoice(choice: Choice, state: RelayCardState): string {
  const text = state[choice.field].text
  return text === '' ? choice.fallback : text
}

/**
 * Render the relay's configuration page.
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
              const on = option.value === currentChoice(choice, state)
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
