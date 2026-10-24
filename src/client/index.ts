/**
 * The relay's browser half: the configuration page of its row on the
 * harness's Plugins page.
 *
 * Deliberately small. The page is the only thing this bundle contributes, and
 * everything operational — pairing, the device list, the certificate pin, the
 * password — stays on the relay's own pages, which work before a person is
 * signed in and from a device other than this one. A settings page can do
 * neither.
 *
 * **Where it sits, from dsh 0.1.7.** Three names have to line up, and each
 * mismatch fails silently:
 *
 * - The client service is `configForms`. The 0.1.5 service, `settingsScope`,
 *   exists in no current client, and a bundle that injects it never applies —
 *   which also holds the whole web boot on a pending entry.
 * - The page registers into `plugins.row.config`, the seat the Plugins page
 *   gives a row a bundle declares: the relay's row on the `dsh-relay` page
 *   gains a configure control that opens this form. `plugins.item` is the
 *   official plugins' list, and the 0.1.5 seat, `settings.plugin.item`, is
 *   gone.
 * - The form is keyed by the **Host entry id** (`relay`) — the row id this
 *   bundle's patch declares, which the settings plane also serves as the
 *   namespace. The slot key is that row id prefixed with the package name.
 *
 * The client context is declared structurally rather than imported from the
 * harness's client packages: this plugin is installed beside a harness it does
 * not control the version of, the same trade the node half makes by reaching
 * everything through `ctx`.
 *
 * The exception is `@deepseek-ai/dsh-client-ui-primitives`, a row of the
 * shell's frozen module table. `SettingsFormModel` is a **value** from it, and
 * re-implementing its staging, revision fencing, and read-back would be
 * several hundred lines of exactly the logic the harness already ships for
 * every settings page. It stays external in the bundle (see the module table
 * in `tsdown.config.ts`), so the harness's copy is the only one, and its types
 * come from the release the build is checked against.
 * @module dsh-relay/client
 */

import { SettingsFormModel, type SettingsFormScope } from '@deepseek-ai/dsh-client-ui-primitives'
import { RelayCard, type RelayCardState, type RelayValue } from './RelayCard.tsx'

/** Package name; the Plugins page lists this bundle under it. */
const PACKAGE_NAME = 'dsh-relay'

/** Namespace the node half's row declares; the join key between the two halves. */
const RELAY_NAMESPACE = 'relay'

/** Slot the Plugins page dispatches for one row's configuration page. */
const CARD_SLOT = 'plugins.row.config'

/** The cell this page occupies: `<package name>#<row id>`, as the Plugins page keys rows. */
const ROW_KEY = `${PACKAGE_NAME}#${RELAY_NAMESPACE}`

/** The write one field's staged text performs, mirroring the primitives' `SettingsFieldWrite`. */
type FieldWrite = { kind: 'set', value: unknown } | { kind: 'clear' }

/** One section field's conversion, mirroring the primitives' `SettingsFieldSpec`. */
interface RelayFieldSpec {
  field: string
  format: (value: unknown) => string
  parse: (text: string) => FieldWrite | undefined
}

/** A free-text field. An empty draft clears the field. */
function textField(field: string): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** A whole-number field. An empty draft clears it; a non-number blocks the save. */
function numberField(field: string): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

/**
 * A field picked from a fixed set of strings, staged by a segmented control.
 * @param field - field name inside the namespace section.
 * @param options - the values the schema accepts.
 */
function choiceField(field: string, options: readonly string[]): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      if (text === '') return { kind: 'clear' }
      return options.includes(text) ? { kind: 'set', value: text } : undefined
    },
  }
}

/** An on/off field, staged by a segmented control as the text `true` or `false`. */
function booleanField(field: string): RelayFieldSpec {
  return {
    field,
    format: value => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      if (text === '') return { kind: 'clear' }
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/**
 * Every field the page stages, in the order a person reasons about them.
 *
 * A control the page renders must have its spec here. The form model plans
 * its writes from these specs, and staging a field it has no spec for throws
 * on the next projection — which takes the whole page down, not one control.
 */
const FIELD_SPECS: readonly RelayFieldSpec[] = [
  textField('bind'),
  numberField('port'),
  numberField('proxyTimeoutMs'),
  numberField('rateLimitPerMinute'),
  choiceField('privilegedMethods', ['allow-authenticated', 'loopback-only']),
  booleanField('uiLink'),
  booleanField('mdns'),
]

/** The writes one page's slot entry injects. */
interface RelayCardActions {
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** The snapshot store the page's bound hook reads through. */
interface RelayCardStore {
  getSnapshot: () => object
  subscribe: (listener: () => void) => () => void
}

/** The shared configuration form for one Host entry, as `ctx.configForms.get` returns it. */
type ConfigFormLike = SettingsFormScope<RelayValue>

/** The slice of the client context this plugin uses. */
interface RelayClientContext {
  configForms: {
    get: (entryId: string) => ConfigFormLike
    whileServed: (
      namespaces: readonly string[],
      register: (served: ReadonlySet<string>) => () => void,
    ) => () => void
  }
  slots: {
    inject: (name: string, register: () => () => void) => () => void
    register: (spec: {
      name: string
      key: string
      inject?: () => object
    }, component: unknown) => () => void
  }
  effect: (callback: () => unknown, label?: string) => void
}

/** Services the renderer must have before this bundle registers anything. */
export const inject = ['slots', 'configForms']

/**
 * Stage the page's edits over the relay namespace and register the page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: RelayClientContext): void {
  // Built here rather than inside the component so the staging survives a
  // render: rebuilding the form on every render would discard drafts the
  // person is still typing.
  const controller = new RelayCardController(ctx.configForms.get(RELAY_NAMESPACE))
  ctx.effect(() => () => { controller.dispose() }, 'dsh-relay: settings form subscription')
  // `whileServed` ties the page to the Host: it registers once the describe
  // mirror carries the namespace and disposes when it stops, so a deployment
  // whose relay row is disabled shows no configure control at all, and a
  // remote browser — served no namespaces — none either. `slots.inject` waits
  // for the Plugins page to declare its slot, since apply order between
  // plugins is unconstrained.
  ctx.effect(
    () => ctx.configForms.whileServed([RELAY_NAMESPACE], () => ctx.slots.inject(CARD_SLOT, () => ctx.slots.register({
      name: CARD_SLOT,
      key: ROW_KEY,
      inject: () => controller.inject(),
    }, RelayCard))),
    'dsh-relay: settings page',
  )
}

/**
 * The relay page's staged form, bound to the namespace the Host serves.
 *
 * `SettingsFormModel` owns the staging, the revision fencing, and the write,
 * but publishes through `bind(project)` and offers no `inject()` of its own —
 * the slot's inject face is the page's business. The harness's own pages each
 * carry a small controller like this one composing the two.
 */
class RelayCardController {
  readonly #scope: ConfigFormLike
  readonly #form: SettingsFormModel<RelayValue>
  readonly #store: RelayCardStore

  /**
   * @param scope - the shared configuration form for the relay entry.
   */
  constructor(scope: ConfigFormLike) {
    this.#scope = scope
    this.#form = new SettingsFormModel<RelayValue>(scope, [...FIELD_SPECS])
    // `bind` builds the store the component subscribes to and keeps it fed
    // from both the scope and the drafts, so it has to exist before the first
    // `inject()` hands it out.
    this.#store = this.#form.bind(() => this.#projection())
  }

  /** One projection of the form, rebuilt whenever the scope or a draft moves. */
  #projection(): RelayCardState {
    // The section as the Host last accepted it, for the read-only lines; the
    // controls read their staged text from the form instead.
    const raw = this.#scope.getSnapshot().value
    const value = (raw !== null && typeof raw === 'object') ? raw as RelayValue : undefined
    return {
      ...this.#form.shell(),
      value,
      bind: this.#form.field('bind'),
      port: this.#form.field('port'),
      proxyTimeoutMs: this.#form.field('proxyTimeoutMs'),
      rateLimitPerMinute: this.#form.field('rateLimitPerMinute'),
      privilegedMethods: this.#form.field('privilegedMethods'),
      uiLink: this.#form.field('uiLink'),
      mdns: this.#form.field('mdns'),
    }
  }

  /**
   * Build the face the page's slot entry injects.
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
