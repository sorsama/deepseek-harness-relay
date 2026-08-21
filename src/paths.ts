/**
 * Where the relay keeps its own files.
 *
 * The harness resolves its home as an explicit override, then `$DSH_HOME`,
 * then `~/.dsh`, and provides `dshHomePath` as a root service. This module
 * prefers that service so a custom home is honoured identically, and mirrors
 * the same precedence when the service is absent (unit tests, a composition
 * that never mounted app-boot).
 * @module dsh-relay/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Directory name of the default harness home under the OS home directory. */
const DEFAULT_HOME_DIR = '.dsh'

/** Environment variable naming an explicit harness home. */
const HOME_ENV = 'DSH_HOME'

/** Subdirectory of the harness home this plugin owns outright. */
const RELAY_DIR = 'relay'

/** Root service shape provided by app-boot; absent outside a booted harness. */
type DshHomePath = (...segments: string[]) => string

/**
 * Expand the tilde prefixes the harness accepts in a configured path.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no prefix is present.
 */
function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the directory holding this plugin's state, certificate, and key.
 * @param ctx - plugin context, read for the optional `dshHomePath` service.
 * @param configured - explicit override from plugin config; empty means unset.
 * @returns the absolute directory path, not yet created on disk.
 */
export function relayStateDir(ctx: Context, configured?: string): string {
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(expandHomePath(configured))
  }
  const provided = ctx.get('dshHomePath') as DshHomePath | undefined
  if (typeof provided === 'function') return provided(RELAY_DIR)
  const fromEnv = process.env[HOME_ENV]
  const home = fromEnv !== undefined && fromEnv.trim().length > 0
    ? fromEnv
    : join(homedir(), DEFAULT_HOME_DIR)
  return join(resolve(expandHomePath(home)), RELAY_DIR)
}
