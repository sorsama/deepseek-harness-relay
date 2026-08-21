/**
 * The harness methods that stay loopback-only unless the operator opts out.
 *
 * The harness pins these itself, re-checking each one against an empty trusted
 * list so only a genuine loopback caller reaches them. The relay's `Host`
 * rewrite makes every proxied request look like a loopback caller, which
 * silently lifts that pin — so the relay keeps its own copy of the list and
 * re-imposes it before proxying.
 *
 * The list is a mirror of `PRIVILEGED_METHODS` in the harness's
 * `packages/client/connection/src/index.ts`. It is pinned by string rather
 * than imported: importing it would make the plugin fail to load against any
 * harness whose package layout moved, and the mirror is checked for drift at
 * startup instead.
 * @module dsh-relay/privileged
 */

/**
 * `/api` method names the harness serves only to loopback callers.
 *
 * They are privileged for two different reasons. The settings and credential
 * domains mutate the operator's configuration and secret store, and READING
 * them is equally sensitive: `settings.describe` returns every exposed
 * namespace and `credentials.describe` reports whether an arbitrary
 * environment variable is configured and where from. `host.pickDirectory` and
 * `host.openPath` act on the host desktop. `llm.discoverModels` carries a
 * draft credential and makes the host issue a request to a URL the caller
 * chose, which is a probe for whatever the host can reach and the client
 * cannot. Agent-preset authoring names the plugins a session runs.
 */
export const PRIVILEGED_METHODS: ReadonlySet<string> = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/**
 * The `/api` method a pathname addresses.
 * @param pathname - the request pathname, already decoded.
 * @returns the method name, or undefined when the path is not an `/api` call.
 */
export function apiMethodOf(pathname: string): string | undefined {
  return pathname.startsWith('/api/') ? pathname.slice('/api/'.length) : undefined
}

/**
 * Whether a request must be refused because it addresses a pinned method.
 * @param pathname - the request pathname.
 * @param allowed - whether this credential class may reach the pinned set.
 * @returns true when the request must be refused before proxying.
 */
export function isPinnedMethod(pathname: string, allowed: boolean): boolean {
  if (allowed) return false
  const method = apiMethodOf(pathname)
  return method !== undefined && PRIVILEGED_METHODS.has(method)
}
