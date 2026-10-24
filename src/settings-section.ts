/**
 * Following edits to the relay's configuration.
 *
 * **How settings work from dsh 0.1.7, which is not how they worked before.**
 *
 * Through 0.1.5 a plugin registered a namespace imperatively —
 * `ctx.settings.register(ns, schema, { base })` — and got back a scope to read
 * and watch. That API is gone. From 0.1.7 the settings plane reads the schema
 * off the **loader entry** itself (`entry.fiber.runtime.Config`), serves the
 * entry's own `id` as the namespace, and edits only the fields the schema
 * marks `.volatile()`. A write lands in the profile patch document.
 *
 * So there is nothing to register here. The namespace is `relay`, the row id
 * this bundle's patch declares, and it exists as soon as the row does — see
 * the default export in `src/index.ts` for the half of that contract which is
 * easy to miss and leaves no error behind.
 *
 * What is left is to **follow the changes**. When an edit touches only
 * volatile fields the loader does not remount the plugin: it writes the new
 * values into the live handles the plugin was given and emits
 * `loader/volatile-update` to that plugin alone. The relay's listeners are
 * built from those values, so the event has to reach the supervisor — and
 * rebinding listeners is exactly the kind of side effect that must not happen
 * while the plugin is unloading. An edit that also changes an ordinary field
 * remounts the plugin instead, which needs nothing from here.
 * @module dsh-relay/settings-section
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Value mirror of the `FiberState` members {@link isUnloading} compares
 * against. A const enum has no runtime object to import, and the comparison
 * happens at runtime.
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** The settings namespace this plugin owns, in both halves: the row id of the bundle patch. */
export const RELAY_NAMESPACE = 'relay'

/**
 * The loader event announcing new values under this plugin's volatile
 * handles. Dispatched with a filter that reaches only listeners of the fiber
 * whose configuration changed, so no namespace check is needed here.
 */
const VOLATILE_UPDATE = 'loader/volatile-update'

/**
 * Whether the consumer's own fiber is tearing down.
 *
 * A change notification during teardown would have the supervisor rebuilding
 * listeners over resources the teardown is releasing.
 * @param ctx - the consumer's plugin context.
 * @returns true while this plugin is unloading or disposed.
 */
function isUnloading(ctx: Context): boolean {
  const state = (ctx as unknown as { fiber: { state: number } }).fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

/**
 * Call [onChange] whenever an edit changes the relay's volatile configuration.
 *
 * The subscription belongs to the plugin's fiber and is released with it. A
 * deployment without the 0.1.7 settings plane never fires the event, and the
 * relay simply runs under the configuration it was composed with.
 * @param ctx - the relay's plugin context.
 * @param onChange - called after the new values are readable through the handles.
 */
export function followSettings(ctx: Context, onChange: () => void): void {
  // An event outside cordis's declared map, so the typed `on` is bypassed.
  const events = ctx as unknown as { on: (event: string, listener: () => void) => () => void }
  events.on(VOLATILE_UPDATE, () => {
    if (isUnloading(ctx)) return
    onChange()
  })
}
