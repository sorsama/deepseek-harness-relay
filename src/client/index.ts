/**
 * The relay's browser half: one card on the harness's Plugins page.
 *
 * Deliberately small. The card is the only thing this bundle contributes, and
 * everything operational — pairing, the device list, the certificate pin, the
 * password — stays on the relay's own pages, which work before a person is
 * signed in and from a device other than this one. A card cannot do either.
 *
 * **What changed for dsh 0.1.7.** Three things, and each one fails silently:
 *
 * - The client service is `configForms`, not `settingsScope`. The old name
 *   appears in no 0.1.7 client bundle, and a service that never arrives leaves
 *   this bundle unloaded with no error anywhere.
 * - The card registers into the Plugins page's `plugins.item` slot. The 0.1.5
 *   seat, `settings.plugin.item`, is not in the 0.1.7 slot map.
 * - The key is the **Host entry id** (`relay`) — the same string the node
 *   half's row declares and the settings plane serves as the namespace. It is
 *   the join between the two halves, so all three names are one value.
 *
 * Types here are declared structurally rather than imported from the harness's
 * client packages. This plugin is installed beside a harness it does not
 * control the version of, and the alternative is four `@deepseek-ai/dsh-*`
 * type dependencies that pin it to one release for no behaviour of their own —
 * the same trade the node half makes by reaching everything through `ctx`.
 *
 * The one exception is `SettingsFormModel`. It is a **value** the shell shares
 * into its frozen module table, and re-implementing its staging, revision
 * fencing, and read-back would be several hundred lines of exactly the logic
 * the harness already ships for every settings card. It stays external in the
 * bundle (see the module table in `tsdown.config.ts`) so the harness's copy is
 * the only one.
 * @module dsh-relay/client
 */

import { SettingsFormModel } from '@deepseek-ai/dsh-client-ui-primitives'
import { RelayCard, type RelayCardState, type RelayValue } from './RelayCard.tsx'

/** Namespace the node half registers; the join key between the two halves. */
const RELAY_NAMESPACE = 'relay'

/** Slot the Plugins page dispatches for one official plugin's configuration. */
const CARD_SLOT = 'plugins.item'

/** One section field's conversion, mirroring the primitives' `SettingsFieldSpec`. */
interface RelayFieldSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => { kind: 'set', value: unknown } | { kind: 'clear' } | undefined
}

/** A free-text field. An empty draft clears the field. */
function textField(field: string): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: text => (text === '' ? { kind: 'clear' } : { kind: 'set', value: text }),
  }
}

/** A whole-number field. An empty draft clears it; a non-number blocks the save. */
function numberField(field: string): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      if (text === '') return { kind: 'clear' }
      const parsed = Number(text)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/** The fields the card edits, in the order a person reasons about them. */
const FIELD_SPECS: readonly RelayFieldSpec[] = [
  textField('bind'),
  numberField('port'),
  numberField('proxyTimeoutMs'),
  numberField('rateLimitPerMinute'),
]

/** The writes one card's slot entry injects. */
interface RelayCardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** The snapshot store the card's bound hook reads through. */
interface RelayCardStore {
  getSnapshot: () => object
  subscribe: (listener: () => void) => () => void
}

/** A reactive settings scope, as `ctx.configForms.get` returns one. */
interface SettingsScopeLike {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
  mutate: (ops: readonly unknown[], expectedRevision?: number) => Promise<boolean>
}

/** The slice of the client context this plugin uses. */
interface RelayClientContext {
  configForms: {
    get: (entryId: string) => SettingsScopeLike
    whileServed: (
      namespaces: readonly string[],
      register: (served: ReadonlySet<string>) => () => void,
    ) => () => void
  }
  slots: {
    inject: (name: string, register: () => void) => void
    register: (spec: {
      name: string
      id?: string
      order?: number
      label?: () => string
      inject?: () => object
    }, component: unknown) => () => void
  }
  effect: (callback: () => unknown, label?: string) => void
  logger?: { warn?: (message: string) => void }
}

/** Services the renderer must have before this bundle registers anything. */
export const inject = ['slots', 'configForms']

/**
 * Stage the card's edits over the relay namespace and register the page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: RelayClientContext): void {
  const scope = ctx.configForms.get(RELAY_NAMESPACE)
  // The controller is built here rather than inside the component so the
  // staging survives a render: the form is revision-fenced, and rebuilding it
  // on every render would discard drafts the person is still typing.
  const controller = new RelayCardController(scope)
  ctx.effect(() => () => { controller.dispose() }, 'dsh-relay: settings form subscription')
  // `whileServed` is what ties the card to the Host: it registers once the
  // describe mirror carries the namespace and disposes when it stops. Without
  // the gate the card mounts against a namespace nothing serves and renders its
  // unavailable line forever; with it, a deployment whose relay row is disabled
  // shows no trace of the card at all.
  //
  // The disposer comes from `register`, not from `inject`: `inject` returns
  // void, because it owns the waiting and the disposal of whatever its callback
  // builds. `whileServed` needs a disposer of its own to hand back, so it gets
  // the registration's.
  ctx.effect(
    () => ctx.configForms.whileServed([RELAY_NAMESPACE], () => {
      let dispose: (() => void) | undefined
      ctx.slots.inject(CARD_SLOT, () => {
        dispose = ctx.slots.register({
          name: CARD_SLOT,
          id: RELAY_NAMESPACE,
          order: 30,
          // The Plugins page draws the title and the disclosure itself, so the
          // card supplies a label and renders only the form body.
          label: () => 'Relay',
          inject: () => controller.inject(),
        }, RelayCard)
      })
      return () => { dispose?.() }
    }),
    'dsh-relay: settings card',
  )
}

/**
 * The relay card's staged form, bound to the namespace the Host serves.
 *
 * This exists because `SettingsFormModel` deliberately stops one step short of
 * what a slot entry needs. It owns the staging, the revision fencing, and the
 * write, but it publishes through `bind(project)` and exposes its writes
 * through `actions()`, and it offers no `inject()` — the slot's inject face is
 * the *card's* business, not the form model's. The harness's own cards each
 * carry a small controller like this one that composes the two; the shape is
 * fixed, and calling `model.inject()` directly is a `TypeError` that surfaces
 * only as an empty `data-slot-error` box on the Plugins page.
 */
class RelayCardController {
  readonly #form: SettingsFormModel<RelayValue>
  readonly #store: RelayCardStore

  /**
   * @param scope - the shared configuration form for the relay entry.
   */
  constructor(scope: unknown) {
    this.#form = new SettingsFormModel<RelayValue>(scope, FIELD_SPECS)
    // `bind` must be called before the first `inject()`: it builds the store
    // the component subscribes to and subscribes it to the scope. A controller
    // that only called `inject()` would expose actions over an unbound store,
    // and the card would render once and never update.
    this.#store = this.#form.bind(() => this.#projection())
  }

  /** One projection of the form, rebuilt whenever the scope or a draft moves. */
  #projection(): RelayCardState {
    const shell = this.#form.shell()
    // The section value comes from the form's own read of the scope, so the
    // switches below the fields can never disagree with the document that the
    // fields are edited against.
    const raw = this.#form.snapshotOf().value
    const value = (raw !== null && typeof raw === 'object') ? raw as RelayValue : undefined
    return {
      ...shell,
      value,
      bind: this.#form.field('bind'),
      port: this.#form.field('port'),
      proxyTimeoutMs: this.#form.field('proxyTimeoutMs'),
      rateLimitPerMinute: this.#form.field('rateLimitPerMinute'),
    }
  }

  /**
   * Build the face the card's slot entry injects.
   * @returns the bound snapshot hook plus the form's edit, reset, save, and discard actions.
   */
  inject(): { hooks: Record<string, RelayCardStore> } & RelayCardActions {
    return {
      hooks: { relayCard: this.#store },
      ...this.#form.actions(),
    }
  }

  /** Release the form's accepted-value subscription. */
  dispose(): void {
    this.#form.dispose()
  }
}
