/**
 * The plugin entry's two contracts with the harness that no listener test
 * reaches: what it refuses to stand in front of, and how a settings edit
 * reaches the running relay.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config, type ConfigSchema } from '../src/index.ts'
import { followSettings } from '../src/settings-section.ts'

/** A resolved schema instance, as the loader hands `apply` one. */
function resolved(): ConfigSchema {
  return Config({ stateDir: '/tmp/dsh-relay-plugin-spec' }) as unknown as ConfigSchema
}

/** Just enough context for `apply` to reach its refusal, which precedes every effect. */
function contextFronting(webServer: { host: string, port?: number, protocol?: string }): Context {
  return {
    webServer: { port: 3080, ...webServer },
    get: () => undefined,
    effect: () => { throw new Error('a refused harness must not get as far as starting the relay') },
  } as unknown as Context
}

describe('what the relay refuses to front', () => {
  it('refuses a harness already listening on every interface', () => {
    expect(() => { apply(contextFronting({ host: '0.0.0.0' }), resolved()) }).toThrow(/bound to 0\.0\.0\.0/)
  })

  it('refuses a harness bound to a LAN address, which 0.2.1 allows', () => {
    expect(() => { apply(contextFronting({ host: '192.168.1.20' }), resolved()) }).toThrow(/bound to 192\.168\.1\.20/)
  })

  it('refuses a loopback harness serving TLS, which a plain forward cannot reach', () => {
    expect(() => {
      apply(contextFronting({ host: '127.0.0.1', protocol: 'https:' }), resolved())
    }).toThrow(/configured with tls/)
  })

  it('fronts a plain loopback harness, IPv4 or IPv6', () => {
    for (const host of ['127.0.0.1', '::1']) {
      let started = false
      const ctx = {
        webServer: { host, port: 3080, protocol: 'http:' },
        get: () => undefined,
        effect: () => { started = true },
      } as unknown as Context
      apply(ctx, resolved())
      expect(started, host).toBe(true)
    }
  })
})

/** A plugin context that records its listeners and reports a chosen fiber state. */
function eventContext(state: { value: number }): { ctx: Context, emit: (event: string) => void } {
  const listeners = new Map<string, (() => void)[]>()
  const ctx = {
    fiber: { get state() { return state.value } },
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return () => undefined
    },
  } as unknown as Context
  return { ctx, emit: (event) => { for (const listener of listeners.get(event) ?? []) listener() } }
}

describe('following a settings edit', () => {
  it('rebuilds when the loader commits new volatile values', () => {
    const state = { value: 2 }
    const { ctx, emit } = eventContext(state)
    let changes = 0
    followSettings(ctx, () => { changes += 1 })
    emit('loader/volatile-update')
    expect(changes).toBe(1)
    // The settings plane's own bookkeeping event is not a change to apply.
    emit('settings/document-updated')
    expect(changes).toBe(1)
  })

  it('stays still while the plugin is unloading', () => {
    const state = { value: 5 }
    const { ctx, emit } = eventContext(state)
    let changes = 0
    followSettings(ctx, () => { changes += 1 })
    emit('loader/volatile-update')
    expect(changes).toBe(0)
  })
})
