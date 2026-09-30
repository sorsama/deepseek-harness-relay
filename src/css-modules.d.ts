/**
 * CSS Modules are compiled inside the client bundle and export their hashed
 * class map as the default export.
 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

/**
 * The shared form model the shell resolves through its frozen module table.
 *
 * Declared structurally rather than through the harness's own types, for the
 * reason given in `src/client/index.ts`: this plugin is mounted beside a
 * harness it does not control the version of, and a real type dependency would
 * pin it to one release for no behaviour of its own.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** The staged form state every plugin card's slot entry injects. */
  interface Shell {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }

  /** One staged field as a control renders it. */
  interface FieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }

  /** How one section field converts between its stored value and draft text. */
  interface FieldSpec {
    field: string
    format: (value: unknown) => string
    parse: (text: string) => { kind: 'set', value: unknown } | { kind: 'clear' } | undefined
  }

  /** The writes one card's slot entry injects. */
  interface Actions {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  }

  /** Observed value holding the card's projection. */
  interface Store<S> {
    getSnapshot: () => S
    subscribe: (listener: () => void) => () => void
  }

  /** The face one card's slot entry injects: its snapshot hook plus the actions. */
  interface Face extends Actions {
    hooks: Record<string, Store<unknown>>
  }

  /** The shared form scope's current read, as the model exposes it. */
  interface ScopeSnapshot<T> {
    status: 'loading' | 'ready' | 'unavailable'
    value: T | undefined
    base: unknown
    user: unknown
    writable: boolean
    revision: number | undefined
  }

  /** Stages one card's edits over one namespace and writes them on save. */
  export class SettingsFormModel<T> {
    constructor(scope: unknown, specs: readonly FieldSpec[], secrets?: readonly unknown[])
    shell(): Shell
    field(field: string): FieldState
    bind<S>(project: () => S): Store<S>
    actions(): Actions
    /** The form scope's current snapshot; `value` is the namespace's section. */
    snapshotOf(): ScopeSnapshot<T>
    save(): Promise<void>
    dispose(): void
  }

  /** A whole-number field spec. */
  export function settingsNumberField(field: string): FieldSpec
  /** A free-text field spec. */
  export function settingsTextField(field: string): FieldSpec

  /** The copy the shared form frame renders. */
  interface FormLabels {
    unavailable: string
    readOnly: string
    saveFailed: string
    save: string
    saving: string
  }

  /** The shared form frame: read-only notice, controls, and the save control. */
  export function SettingsForm(props: {
    labels: FormLabels
    state: Shell
    onSave: () => void
    onDiscard: () => void
    children?: unknown
  }): JSX.Element

  /** One labelled control for a section field. */
  export function SettingsValueField(props: {
    id: string
    label: string
    hint?: string
    text: string
    overridden: boolean
    invalid: boolean
    overriddenLabel: string
    resetLabel: string
    invalidLabel: string
    disabled: boolean
    numeric?: boolean
    placeholder?: string
    onEdit: (text: string) => void
    onReset: () => void
  }): JSX.Element
}
