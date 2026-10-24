/**
 * The browser half's registration and form, driven against the harness's own
 * `SettingsFormModel` rather than a stand-in.
 *
 * What this pins is the failure that leaves no trace but an empty error box on
 * the Plugins page: a control that stages a field the form model has no spec
 * for throws on the next projection, and takes the whole page down with it.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

/**
 * `@deepseek-ai/dsh-client-store`'s snapshot store, reduced to the face the
 * form model uses. A declaration, so the hoisted mock factory can reach it.
 * @param initial - the first snapshot.
 * @returns the store.
 */
function createSnapshotStore(initial: unknown) {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next: unknown) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

// The primitives bundle leaves its own dependencies (markdown, highlighting,
// icons) to the shell, so it cannot be imported whole outside one. The form
// model is a self-contained region of it with one import, so that region is
// lifted out of the installed release and evaluated as-is: the model under
// test is the harness's, byte for byte, not a re-implementation of it.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { readFile } = await import('node:fs/promises')
  const bundle = await readFile(
    new URL('../node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js', import.meta.url),
    'utf8',
  )
  const start = bundle.indexOf('//#region lib/types/settings-form/form-model.js')
  const end = bundle.indexOf('//#endregion', start)
  if (start < 0 || end < 0) throw new Error('the primitives bundle no longer carries the form-model region')
  const SettingsFormModel = new Function('createSnapshotStore', `${bundle.slice(start, end)}\nreturn SettingsFormModel`)(createSnapshotStore) as unknown
  return { SettingsFormModel, SettingsForm: () => null, SettingsValueField: () => null }
})

/** The relay section as the Host would serve it. */
const SECTION = {
  bind: '0.0.0.0',
  port: 3443,
  proxyTimeoutMs: 120_000,
  rateLimitPerMinute: 600,
  privilegedMethods: 'allow-authenticated',
  uiLink: true,
  mdns: true,
  tls: 'self-signed',
}

/** A configuration form over [SECTION] that records every write. */
function formScope() {
  const writes: unknown[][] = []
  const listeners = new Set<() => void>()
  const snapshot = { status: 'ready', value: SECTION, base: SECTION, user: {}, writable: true, revision: 3 }
  return {
    writes,
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      mutate: async (ops: readonly unknown[]) => {
        writes.push([...ops])
        return true
      },
    },
  }
}

/** Mount the browser half and capture what it registers. */
function mount() {
  const { scope, writes } = formScope()
  const served: string[][] = []
  const registered: { spec: { name: string, key: string, inject?: () => object }, component: unknown }[] = []
  const ctx = {
    configForms: {
      get: (id: string) => {
        expect(id).toBe('relay')
        return scope
      },
      whileServed: (namespaces: readonly string[], register: () => () => void) => {
        served.push([...namespaces])
        return register()
      },
    },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (spec: { name: string, key: string, inject?: () => object }, component: unknown) => {
        registered.push({ spec, component })
        return () => undefined
      },
    },
    effect: (callback: () => unknown) => { callback() },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0])
  return { served, registered, writes }
}

interface Face {
  hooks: { relayCard: { getSnapshot: () => Record<string, { text: string } | unknown> & { dirty: boolean } } }
  edit: (field: string, text: string) => void
  save: () => void
}

describe('the browser half', () => {
  it('waits for the services it binds to', () => {
    expect(inject).toEqual(['slots', 'configForms'])
  })

  it('registers the relay row\'s configuration page while the Host serves the namespace', () => {
    const { served, registered } = mount()
    expect(served).toEqual([['relay']])
    expect(registered).toHaveLength(1)
    expect(registered[0]?.spec.name).toBe('plugins.row.config')
    expect(registered[0]?.spec.key).toBe('dsh-relay#relay')
  })

  it('stages every switch the page renders, and saves it as the schema\'s own type', async () => {
    const { registered, writes } = mount()
    const face = registered[0]?.spec.inject?.() as Face
    const store = face.hooks.relayCard
    // Each of these used to throw "plugin card has no field" on the next
    // projection, because the switches had no spec.
    face.edit('uiLink', 'false')
    face.edit('mdns', 'false')
    face.edit('privilegedMethods', 'loopback-only')
    face.edit('port', '3450')
    const staged = store.getSnapshot()
    expect(staged.dirty).toBe(true)
    expect((staged.uiLink as { text: string }).text).toBe('false')
    expect((staged.privilegedMethods as { text: string }).text).toBe('loopback-only')

    face.save()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual([[
      { op: 'set', path: ['uiLink'], value: false },
      { op: 'set', path: ['mdns'], value: false },
      { op: 'set', path: ['privilegedMethods'], value: 'loopback-only' },
      { op: 'set', path: ['port'], value: 3450 },
    ]])
  })

  it('writes nothing for a switch set back to the value already stored', async () => {
    const { registered, writes } = mount()
    const face = registered[0]?.spec.inject?.() as Face
    face.edit('uiLink', 'true')
    expect(face.hooks.relayCard.getSnapshot().dirty).toBe(false)
    face.save()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual([])
  })
})
