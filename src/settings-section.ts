/**
 * Publishing the relay's configuration to the harness settings service.
 *
 * Registering a namespace is what puts the relay on the web UI's **Plugin
 * configuration** tab: that tab enumerates the namespaces the host serves and
 * dispatches one keyed slot per namespace, so the browser half's card and this
 * registration are two halves of one feature and share the namespace string.
 *
 * The wiring is a local copy of `installSettingsSection` from
 * `@deepseek-ai/dsh-settings` rather than an import of it. It is twenty lines
 * over two services this plugin already reaches through `ctx`, and importing
 * it would pin an out-of-tree plugin to one harness release in exchange for no
 * behaviour of its own.
 * @module dsh-relay/settings-section
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'

/**
 * Value mirror of the `FiberState` members {@link isUnloading} compares
 * against. A const enum has no runtime object to import, and the comparison
 * happens at runtime.
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** The settings namespace this plugin owns, in both halves. */
export const RELAY_NAMESPACE = 'relay'

/** Namespaces must be lowercase kebab-case, as the service brands them. */
const NAMESPACE_PATTERN = /^[a-z][\da-z]*(-[\da-z]+)*$/

/** The slice of the settings service this module uses. */
interface SettingsService {
  register: <T>(ns: string, schema: z<T>, options?: { base?: T }) => {
    get: () => T
    watch: (callback: (next: T, previous: T) => void) => () => void
  }
}

/**
 * Whether the consumer's own fiber is tearing down, rather than merely losing
 * the settings service.
 *
 * The distinction decides whether a change notification is useful or harmful:
 * a provider detaching leaves the relay running and it must fall back to its
 * composition entry, while the relay's own unload would have `onChange`
 * rebuilding listeners over resources the teardown is releasing.
 * @param ctx - the consumer's plugin context.
 * @returns true while this plugin is unloading or disposed.
 */
function isUnloading(ctx: Context): boolean {
  const state = (ctx as unknown as { fiber: { state: number } }).fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Register the relay's configuration as an editable settings namespace.
 *
 * While a settings service exists, the composition entry becomes the `base`
 * layer and the resolved scope becomes the authoritative source; when the
 * service goes away the relay falls back to the entry it was composed with, so
 * a deployment that never mounted settings behaves exactly as configured.
 * @param ctx - the relay's plugin context.
 * @param schema - the plugin's own Config schema.
 * @param entry - the configuration composed from `cordis.yml`.
 * @param hooks.setSource - receives a thunk returning the authoritative value.
 * @param hooks.onChange - called after every change to that value.
 */
export function installSettingsSection<T>(
  ctx: Context,
  schema: z<T>,
  entry: T,
  hooks: { setSource: (current: () => T) => void, onChange: () => void },
): void {
  if (!NAMESPACE_PATTERN.test(RELAY_NAMESPACE)) {
    throw new Error(`dsh-relay: settings namespace ${JSON.stringify(RELAY_NAMESPACE)} must be lowercase kebab-case`)
  }
  ctx.inject(['settings'], (scoped: Context) => {
    const settings = scoped.get('settings') as unknown as SettingsService
    const scope = settings.register(RELAY_NAMESPACE, schema, { base: entry })
    hooks.setSource(() => scope.get())
    // The stored document may already override the composed entry, so the
    // resolved value can differ the moment the service attaches.
    hooks.onChange()
    scoped.effect(() => () => {
      // Two different reasons reach this disposer. A settings provider
      // detaching leaves the relay running, so it must fall back to the
      // composition entry and re-judge what it built from it. The relay's own
      // unload runs it too, and there the notification is actively harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    }, 'dsh-relay: settings fallback')
    scope.watch(() => {
      // A stored change landing during teardown reaches the watcher before the
      // registration is released, and is as harmful here as in the disposer.
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}
