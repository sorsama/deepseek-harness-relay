/**
 * The two half-contracts that make the relay's settings card exist at all.
 *
 * Both fail **silently**, which is why they are pinned here rather than left to
 * a real boot. On dsh 0.1.7:
 *
 * 1. The settings plane reads the schema off the object the Cordis loader
 *    registers — `entry.fiber.runtime.Config` — and the loader normalizes a
 *    module's exports to `exports.default ?? exports` first. A module exporting
 *    a bare `apply` function therefore has no `.Config` to find, and its entry
 *    is served to no client: `settings/describe` returns it in no namespace
 *    list, and the browser card has nothing to attach to. Nothing logs.
 *
 * 2. `volatileForm()` keeps **only** fields whose nearest marked ancestor is
 *    volatile, and `describe()` drops any entry whose form came back
 *    `undefined`. A schema with no `.volatile()` is not an empty settings page;
 *    it is no settings page.
 *
 * Measured against dsh 0.1.7-rc.2: with only the named exports and a
 * non-volatile schema, this plugin contributed zero namespaces.
 */
import { describe, expect, it } from 'vitest'
import plugin, { apply, Config, inject, name, plainConfig } from '../src/index.ts'

/** The fields the settings page should offer, and so the ones needing `.volatile()`. */
const FORM_FIELDS = [
  'bind',
  'port',
  'trustedHosts',
  'publicHostnames',
  'tls',
  'tlsCertPath',
  'tlsKeyPath',
  'auth',
  'sessionTtlMs',
  'deviceTokenTtlMs',
  'pairingWindowMs',
  'pairingCodeLength',
  'maxFailedAttempts',
  'lockoutMs',
  'rateLimitPerMinute',
  'privilegedMethods',
  'extraProxyPaths',
  'proxyTimeoutMs',
  'uiLink',
  'mdns',
  'mdnsName',
]

describe('the settings-card contract', () => {
  it('registers a default export, because that is the object the loader reads Config off', () => {
    // `unwrapExports` is `exports.default ?? exports`, and `runtime.Config` is
    // read from the result. Without a default export this is the module
    // namespace object, which has a `Config` — so the assertion that matters is
    // that the default export is the plugin object AND carries the schema.
    expect(plugin).toBeDefined()
    expect(plugin.Config).toBe(Config)
    expect(plugin.name).toBe(name)
    expect(plugin.inject).toEqual(inject)
    expect(plugin.apply).toBe(apply)
  })

  it('carries the entry name the Host serves as the settings namespace', () => {
    // The namespace is the loader entry id, which the bundle patch declares as
    // `relay`. The browser half keys its card on the same string, so a rename
    // on either side silently detaches the card.
    expect(name).toBe('relay')
  })

  it('marks every form field volatile, or the page is never generated', () => {
    const resolved = Config({ stateDir: '/tmp/relay-contract' }) as unknown as Record<string, unknown>
    // Volatility is observed rather than introspected: a volatile field
    // resolves to a handle, and a non-volatile one to a plain value. Asserting
    // on that is exact, where walking schemastery's serialized JSON is a guess
    // at its internal shape.
    for (const field of FORM_FIELDS) {
      const value = resolved[field]
      const isHandle = typeof (value as { get?: unknown })?.get === 'function'
      const nestedHandles = field === 'compat'
        && Object.values(value as Record<string, unknown>)
          .every(leaf => typeof (leaf as { get?: unknown })?.get === 'function')
      expect(isHandle || nestedHandles, `${field} must be .volatile()`).toBe(true)
    }
    // The deliberate exception: `stateDir` is derived by the bundle patch and
    // kept off the form, so it must stay a plain value.
    expect(typeof (resolved.stateDir as { get?: unknown })?.get).toBe('undefined')
    expect(resolved.stateDir).toBe('/tmp/relay-contract')
  })

  it('resolves every volatile field to a live handle, which plainConfig unwraps', () => {
    const resolved = Config({ stateDir: '/tmp/relay-contract' }) as unknown as Record<string, unknown>
    // A handle has `get`; a plain value does not. This is what makes a settings
    // edit visible to a running relay instead of frozen at process start.
    for (const field of FORM_FIELDS) {
      const value = resolved[field]
      const isHandle = typeof (value as { get?: unknown })?.get === 'function'
      // `compat` is a nested object whose leaves are handles.
      const nestedIsHandles = field === 'compat'
        ? Object.values(value as Record<string, unknown>)
          .every(leaf => typeof (leaf as { get?: unknown })?.get === 'function')
        : false
      expect(isHandle || nestedIsHandles, `${field} should resolve to a volatile handle`).toBe(true)
    }

    const plain = plainConfig(resolved as Parameters<typeof plainConfig>[0])
    expect(plain.stateDir).toBe('/tmp/relay-contract')
    expect(plain.port).toBe(3443)
    expect(plain.tls).toBe('self-signed')
    expect(plain.privilegedMethods).toBe('allow-authenticated')
    expect(plain.compat.addressGrants).toBe(true)
    // The arrays are copied out of their handles rather than aliased, so the
    // plugin can keep treating them as mutable data.
    expect(Array.isArray(plain.trustedHosts)).toBe(true)
  })
})
