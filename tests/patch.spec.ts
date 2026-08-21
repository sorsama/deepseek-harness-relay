/**
 * The bundle patch is the only file here that no compiler or test touched
 * until it reached a real harness, and a YAML mistake in it fails the whole
 * profile boot rather than just this plugin — the loader parses every bundle
 * layer before it mounts anything.
 *
 * The specific trap this pins: a `!` immediately after the `!!js` tag reads as
 * a second tag property, so `disabled: !!js !ctx.foo` is a parse error and not
 * a negation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/** One `!!js` expression, kept as its source text rather than evaluated. */
interface JsExpression {
  readonly source: string
}

/**
 * The harness evaluates `!!js` against a live context. Here it is enough to
 * capture the expression text, which is what proves the document parsed.
 * js-yaml is pinned to the major the harness itself parses with.
 */
const JS_TAG = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (source: string): JsExpression => ({ source }),
  resolve: () => true,
})

const PATCH_SCHEMA = DEFAULT_SCHEMA.extend([JS_TAG])

interface PatchRow {
  readonly id: string
  readonly name?: string
  readonly disabled?: unknown
  readonly config?: Record<string, unknown>
}

type PatchEntry = PatchRow | { readonly insert: readonly PatchRow[] }

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

describe('cordis.patch.yml', () => {
  const parsed = load(readFileSync(patchPath, 'utf8'), { schema: PATCH_SCHEMA }) as PatchEntry[]

  it('parses — a tag error here fails the whole profile boot, not just this plugin', () => {
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('inserts exactly the two rows this bundle owns and overrides nothing', () => {
    const inserts = parsed.flatMap(entry => ('insert' in entry ? entry.insert : []))
    expect(inserts.map(row => row.id)).toEqual(['relay-startup', 'relay'])
    // An entry outside an `insert` would be overriding somebody else's row.
    expect(parsed.every(entry => 'insert' in entry)).toBe(true)
  })

  it('leaves the harness webserver row alone', () => {
    const targeted = parsed.flatMap(entry => ('insert' in entry ? entry.insert : [entry])).map(row => row.id)
    expect(targeted).not.toContain('webserver')
    expect(targeted).not.toContain('connection')
  })

  it('reads every flag-backed value through a js expression', () => {
    const relay = parsed
      .flatMap(entry => ('insert' in entry ? entry.insert : []))
      .find(row => row.id === 'relay')
    expect(relay).toBeDefined()
    // `disabled` is the one that bit: `!!js !ctx...` is two tags, not a negation.
    expect((relay?.disabled as JsExpression).source).toBe('ctx.relayStartup.enabled === false')
    for (const key of ['bind', 'port', 'stateDir', 'tls', 'publicHostnames']) {
      const value = relay?.config?.[key] as JsExpression
      expect(value.source, key).toMatch(/\S/)
      expect(value.source, key).not.toMatch(/^!/)
    }
  })
})
